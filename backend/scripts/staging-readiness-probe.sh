#!/usr/bin/env bash
# staging-readiness-probe.sh
#
# Falsifiable readiness probe — run before `wrangler deploy --env staging`.
# Surfaces three Day-3 unknowns:
#   1) R2_BUCKET declared required in types but unbound in wrangler
#   2) CASCADE_* in types vs UNBROWSE_CASCADE_* in CF secret store
#   3) FAL_KEY / TURBOBOX_URL required-by-type, presence on staging unknown
#
# Exits 0 on GREEN, 1 on YELLOW (manual review), 2 on RED (blocker).
#
# Harness collects, agent judges. The verdict logic flags evidence — the
# human reviewer reads the report and signs off.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="$ROOT/backend"
SRC="$BACKEND/src"
CFG="$BACKEND/wrangler.ci.toml"
ENVNAME="staging"

YELLOW=0
RED=0

hr() { printf '\n============================================================\n%s\n============================================================\n' "$1"; }

hr "1) env.X accesses in backend/src"
ACCESSES_RAW="$(grep -rhoE 'env\.[A-Z][A-Z0-9_]+' "$SRC" 2>/dev/null | sort -u)"
echo "$ACCESSES_RAW"
ACCESSES="$(echo "$ACCESSES_RAW" | sed 's/^env\.//')"

hr "2) Required-by-type bindings (no '?' in types.ts Env)"
REQUIRED="$(awk '
  /^export interface Env/{flag=1; next}
  flag && /^}/{flag=0}
  flag && /^[[:space:]]*[A-Z][A-Z0-9_]*:[[:space:]]/ {
    sub(/^[[:space:]]+/, "", $0);
    split($0, a, ":");
    print a[1];
  }
' "$SRC/types.ts")"
echo "$REQUIRED"

hr "3) Staging secret list (wrangler secret list --env $ENVNAME)"
SECRETS_JSON="$(cd "$BACKEND" && wrangler secret list --env "$ENVNAME" --config "$CFG" 2>&1)"
echo "$SECRETS_JSON"
SECRETS="$(echo "$SECRETS_JSON" | grep -oE '"name":[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' | sort -u)"

hr "4) Required-by-type but missing from staging secret list"
MISSING=""
for name in $REQUIRED; do
  if ! echo "$SECRETS" | grep -qx "$name"; then
    MISSING+=" $name"
    echo "  MISSING: $name"
  fi
done
if [ -z "$MISSING" ]; then
  echo "  (none — all required names present as secrets)"
fi

hr "5) R2_BUCKET call-sites in backend/src"
R2_HITS="$(grep -rn 'env\.R2_BUCKET' "$SRC" 2>/dev/null)"
if [ -z "$R2_HITS" ]; then
  echo "  ZERO HITS — R2_BUCKET is type-declared but unused at runtime."
  R2_USED=0
else
  echo "$R2_HITS"
  R2_USED=1
fi

hr "5b) Is R2_BUCKET reachable from a mounted route?"
R2_REACHABLE=0
if [ "$R2_USED" = "1" ]; then
  R2_FILES="$(echo "$R2_HITS" | cut -d: -f1 | sort -u)"
  for f in $R2_FILES; do
    base="$(basename "$f" .ts)"
    echo "  uses R2_BUCKET: $f"
    importers="$(grep -rln "from.*['\"].*/$base" "$SRC" 2>/dev/null | grep -v "^$f$" || true)"
    if [ -z "$importers" ]; then
      echo "    NO IMPORTERS — file is dead code."
      continue
    fi
    echo "    importers:"
    echo "$importers" | sed 's/^/      /'
    for imp in $importers; do
      ibase="$(basename "$imp" .ts)"
      mounted="$(grep -n "from.*['\"].*$ibase['\"]" "$SRC/index.ts" 2>/dev/null || true)"
      if [ -n "$mounted" ]; then
        echo "    MOUNTED via index.ts: $mounted"
        R2_REACHABLE=1
      else
        echo "    NOT mounted directly in index.ts (transitive reach not checked)."
      fi
    done
  done
fi

hr "6) CASCADE prefix mapping (UNBROWSE_CASCADE_* → CASCADE_*)"
PREFIX_HITS="$(grep -rn 'UNBROWSE_CASCADE' "$BACKEND" --include="*.ts" --include="*.toml" 2>/dev/null | grep -v node_modules || true)"
if [ -z "$PREFIX_HITS" ]; then
  echo "  ZERO HITS — no UNBROWSE_CASCADE_* references in backend source."
  echo "  If CF stores secrets under that prefix, they are NEVER read."
  CASCADE_MAP_OK=0
else
  echo "$PREFIX_HITS"
  CASCADE_MAP_OK=1
fi

hr "6b) Are CASCADE_* secrets present on staging under the bare name?"
CASCADE_PRESENT=0
for c in CASCADE_PLATFORM_WALLET CASCADE_SIGNER_SECRET_KEY CASCADE_RPC_URL CASCADE_RPC_WS_URL; do
  if echo "$SECRETS" | grep -qx "$c"; then
    echo "  PRESENT: $c"
    CASCADE_PRESENT=1
  else
    echo "  ABSENT:  $c"
  fi
done

hr "7) FAL_KEY / TURBOBOX_URL usage + presence"
FAL_TURBO_BLOCKER=0
for k in FAL_KEY TURBOBOX_URL; do
  hits="$(grep -rn "env\\.$k" "$SRC" 2>/dev/null || true)"
  if [ -z "$hits" ]; then
    echo "  $k: ZERO usage → type-only declaration, deploy-safe."
    continue
  fi
  echo "  $k: used at:"
  echo "$hits" | sed 's/^/    /'
  present=0
  if echo "$SECRETS" | grep -qx "$k"; then
    echo "    secret PRESENT on staging."
    present=1
  else
    echo "    secret ABSENT on staging."
  fi
  # Reachability: only mounted demos route uses these.
  if grep -qn "from.*demos" "$SRC/index.ts" 2>/dev/null; then
    echo "    demos route IS mounted in index.ts."
    if [ "$present" = "0" ]; then FAL_TURBO_BLOCKER=1; fi
  else
    echo "    demos route NOT mounted in index.ts → dead path, deploy-safe."
  fi
done

hr "8) Wrangler dry-run"
DRY="$(cd "$BACKEND" && wrangler deploy --config "$CFG" --env "$ENVNAME" --dry-run --outdir /tmp/staging-readiness-dry 2>&1)"
echo "$DRY" | tail -40

hr "VERDICT"

if [ "$R2_USED" = "1" ] && [ "$R2_REACHABLE" = "1" ]; then
  echo "RED: R2_BUCKET used by mounted code but no R2 binding in wrangler config."
  RED=1
elif [ "$R2_USED" = "1" ]; then
  echo "  R2_BUCKET used only in unmounted code (demos route) → dead path."
fi

if [ "$FAL_TURBO_BLOCKER" = "1" ]; then
  echo "RED: FAL_KEY or TURBOBOX_URL used by mounted code but absent from staging secrets."
  RED=1
fi

if [ "$CASCADE_MAP_OK" = "0" ]; then
  if [ "$CASCADE_PRESENT" = "1" ]; then
    echo "  CASCADE_* present on staging under bare name; source reads bare name → mapping unneeded."
  else
    echo "  CASCADE_* absent on staging; cascade payouts disabled at runtime (cascade.ts guards on optional fields)."
    YELLOW=1
  fi
fi

if [ "$RED" = "1" ]; then
  echo
  echo "VERDICT: RED — DO NOT DEPLOY. Resolve blockers above."
  exit 2
elif [ "$YELLOW" = "1" ]; then
  echo
  echo "VERDICT: YELLOW — deploy with manual review. Optional features degrade gracefully."
  echo "Day-5 command (after sign-off):"
  echo "  cd backend && wrangler deploy --config wrangler.ci.toml --env staging"
  exit 1
else
  echo
  echo "VERDICT: GREEN — deploy safe."
  echo "Day-5 command:"
  echo "  cd backend && wrangler deploy --config wrangler.ci.toml --env staging"
  exit 0
fi
