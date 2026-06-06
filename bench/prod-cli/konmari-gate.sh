#!/usr/bin/env bash
# konmari-gate.sh — the falsifiable signal that unbrowse stays light.
# Two ratcheting invariants:
#   1. DEPS: the konmari-removed deps stay removed, and runtime deps stay <= a ceiling.
#      (catches a cut dep silently creeping back — Luke 15:4, the one lost sheep).
#   2. WEIGHT: the published package's UNPACKED size stays <= a ceiling (MB). Lower the
#      ceiling as binaries are pruned; the gate fails if the package grows.
# Tune via env: DEP_CEIL (default 7), SIZE_CEIL_MB (default 64).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
PKG=packages/skill/package.json
fail=0

echo "=== DEPS: removed deps stay removed + count under ceiling ==="
for d in '@x402/fetch' '@solana/kit' '@fastify/rate-limit' '@faremeter/flex-solana'; do
  if node -e "const p=require('./$PKG');process.exit(((p.dependencies&&p.dependencies['$d'])||(p.optionalDependencies&&p.optionalDependencies['$d']))?0:1)"; then
    echo "[konmari] FAIL: removed dep crept back: $d"; fail=1
  fi
done
NDEPS=$(node -p "Object.keys(require('./$PKG').dependencies||{}).length")
DEP_CEIL=${DEP_CEIL:-7}
if [ "$NDEPS" -le "$DEP_CEIL" ]; then echo "[konmari] runtime deps $NDEPS <= $DEP_CEIL ✓"; else echo "[konmari] FAIL: runtime deps $NDEPS > $DEP_CEIL"; fail=1; fi

echo "=== WEIGHT: published package unpacked size under ceiling ==="
SIZE_CEIL_MB=${SIZE_CEIL_MB:-64}
LINE="$(npm pack --workspace packages/skill --dry-run 2>&1 | grep -iE 'unpacked size' | head -1)"
# parse "... unpacked size: 63.4 MB" -> 63.4 ; handle kB/MB
NUM="$(printf '%s' "$LINE" | grep -oE '[0-9]+(\.[0-9]+)?' | tail -1)"
UNIT="$(printf '%s' "$LINE" | grep -oiE 'kb|mb|gb' | tail -1 | tr 'A-Z' 'a-z')"
case "$UNIT" in kb) MB="$(node -p "$NUM/1024")";; gb) MB="$(node -p "$NUM*1024")";; *) MB="$NUM";; esac
if [ -z "$NUM" ]; then echo "[konmari] FAIL: could not measure package size ($LINE)"; fail=1; else
  OVER="$(node -p "$MB > $SIZE_CEIL_MB ? 1 : 0")"
  if [ "$OVER" = "0" ]; then echo "[konmari] unpacked ${MB} MB <= ${SIZE_CEIL_MB} MB ✓"; else echo "[konmari] FAIL: unpacked ${MB} MB > ${SIZE_CEIL_MB} MB ceiling"; fail=1; fi
fi

echo "=== INSTALL: pruned on-disk footprint under ceiling (the host-only binary win) ==="
# Pack + install in a throwaway prefix; the postinstall prune deletes foreign binaries, so
# the on-disk install is host-only. Skip with KONMARI_SKIP_INSTALL=1 (the fast dep+weight
# checks above still run). Ceiling tuned via INSTALL_CEIL_MB (default 28).
if [ "${KONMARI_SKIP_INSTALL:-0}" = "1" ]; then
  echo "[konmari] install footprint check skipped (KONMARI_SKIP_INSTALL=1)"
else
  INSTALL_CEIL_MB=${INSTALL_CEIL_MB:-28}
  WK="$(mktemp -d /tmp/konmari-install.XXXXXX)"
  if npm pack --workspace packages/skill --pack-destination "$WK" >/dev/null 2>&1; then
    TGZ="$(ls "$WK"/unbrowse-*.tgz 2>/dev/null | head -1)"
    ( cd "$WK" && npm init -y >/dev/null 2>&1 && npm install "$TGZ" --no-audit --no-fund >/dev/null 2>&1 )
    IMB="$(du -sm "$WK/node_modules/unbrowse" 2>/dev/null | cut -f1)"
    if [ -n "$IMB" ] && [ "$IMB" -le "$INSTALL_CEIL_MB" ]; then echo "[konmari] installed (host-only) ${IMB} MB <= ${INSTALL_CEIL_MB} MB ✓"
    else echo "[konmari] FAIL: installed ${IMB:-?} MB > ${INSTALL_CEIL_MB} MB (prune not effective?)"; fail=1; fi
  else echo "[konmari] FAIL: pack failed for install check"; fail=1; fi
  rm -rf "$WK"
fi

echo "================================================"
[ "$fail" -eq 0 ] && { echo "[konmari] PASS — light held (deps cut, weight + pruned-install under ceiling)"; exit 0; } \
                  || { echo "[konmari] FAIL — konmari regressed"; exit 1; }
