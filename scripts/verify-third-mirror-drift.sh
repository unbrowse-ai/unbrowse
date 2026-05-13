#!/usr/bin/env bash
# verify-third-mirror-drift.sh
#
# Falsifier for the third mirror at .agents/skills/unbrowse/src/mcp.ts.
# Lights up if:
#   (a) canonical maybePostProcessResult changes while mirror stays frozen
#       (drift DEEPENED — the deferred decision is now older debt)
#   (b) mirror maybePostProcessResult changes at all
#       (something MOVED — promoted/synced/deleted? agent must look)
#
# On a clean run with no change, exits 0 silently.
# First run records a baseline at scripts/.third-mirror-baseline.
#
# Structural extraction: from the line declaring `maybePostProcessResult`
# up to the next top-level `^}` (column-0 closing brace). Both files have
# this pattern verified at authoring time (canonical L828..L855, mirror
# L365..L392). Whitespace is stripped before hashing so cosmetic edits
# don't trigger a false alarm.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANON="$ROOT/src/mcp.ts"
MIRROR="$ROOT/.agents/skills/unbrowse/src/mcp.ts"
BASELINE="$ROOT/scripts/.third-mirror-baseline"

if command -v sha256sum >/dev/null 2>&1; then
  HASH() { sha256sum | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  HASH() { shasum -a 256 | awk '{print $1}'; }
else
  echo "verify-third-mirror-drift: no sha256sum or shasum on PATH" >&2
  exit 2
fi

extract_fn() {
  local file="$1"
  awk '
    /function maybePostProcessResult/ { inside=1 }
    inside { print }
    inside && NR>1 && /^}/ && !/function maybePostProcessResult/ { exit }
  ' "$file"
}

stable_hash() {
  local file="$1"
  extract_fn "$file" | tr -d ' \t\n\r' | HASH
}

[[ -f "$CANON"  ]] || { echo "missing $CANON"  >&2; exit 2; }
[[ -f "$MIRROR" ]] || { echo "missing $MIRROR" >&2; exit 2; }

CANON_HASH="$(stable_hash "$CANON")"
MIRROR_HASH="$(stable_hash "$MIRROR")"

if [[ ! -f "$BASELINE" ]]; then
  {
    echo "# third-mirror drift baseline — created $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# canonical: src/mcp.ts :: maybePostProcessResult"
    echo "# mirror:    .agents/skills/unbrowse/src/mcp.ts :: maybePostProcessResult"
    echo "CANON_HASH=$CANON_HASH"
    echo "MIRROR_HASH=$MIRROR_HASH"
  } > "$BASELINE"
  echo "verify-third-mirror-drift: baseline created at $BASELINE"
  echo "  CANON_HASH=$CANON_HASH"
  echo "  MIRROR_HASH=$MIRROR_HASH"
  exit 0
fi

BASE_CANON="$(awk -F= '/^CANON_HASH=/  {print $2}' "$BASELINE")"
BASE_MIRROR="$(awk -F= '/^MIRROR_HASH=/ {print $2}' "$BASELINE")"

CANON_CHANGED=0
MIRROR_CHANGED=0
[[ "$CANON_HASH"  != "$BASE_CANON"  ]] && CANON_CHANGED=1
[[ "$MIRROR_HASH" != "$BASE_MIRROR" ]] && MIRROR_CHANGED=1

if [[ "$MIRROR_CHANGED" -eq 1 ]]; then
  cat >&2 <<EOF
verify-third-mirror-drift: FAIL — third mirror MOVED.
  .agents/skills/unbrowse/src/mcp.ts :: maybePostProcessResult changed.
  baseline mirror hash: $BASE_MIRROR
  current  mirror hash: $MIRROR_HASH
  Decide: was it promoted to canonical, synced from canonical, or deleted?
  After deciding, update $BASELINE (or delete it to re-baseline).
EOF
  exit 1
fi

if [[ "$CANON_CHANGED" -eq 1 ]]; then
  cat >&2 <<EOF
verify-third-mirror-drift: FAIL — drift DEEPENED.
  Canonical src/mcp.ts evolved; .agents/skills/unbrowse/src/mcp.ts did not.
  baseline canonical hash: $BASE_CANON
  current  canonical hash: $CANON_HASH
  mirror   hash (frozen):  $MIRROR_HASH
  The "promote-or-delete in a later loop" deferral is now older debt.
  Action: promote the mirror's signature, sync it from canonical, or delete it.
  After acting, update $BASELINE.
EOF
  exit 1
fi

echo "verify-third-mirror-drift: ok (no change since baseline)"
exit 0
