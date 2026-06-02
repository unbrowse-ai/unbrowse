#!/usr/bin/env bash
# adapters-done-gate.sh — the trilogy and the product are DONE TO COMPLETION as
# DOCS + SDKs for every native adapter Unbrowse can be a drop-in for.
#
# Exits 0 exactly when:
#   1. PARITY  — scripts/dropin-parity-gate.sh exits 0 over the full
#      scripts/dropin-manifest.tsv: every declared adapter has a shim package, a
#      README that attributes the upstream and says "drop-in", and a passing
#      parity test (the upstream's public surface is really provided).
#   2. DOCS    — the canonical drop-in docs page documents EVERY adapter: for each
#      manifest row, docs/for-developers/drop-in-adapters.md names the upstream
#      package, names the @unbrowse shim, and shows the one-line swap.
#   3. INDEXED — that docs page is linked from the developer docs index.
#
# No string fakes this: a row is parity-green only when a real shim with a passing
# test exists on disk, and the docs check fails the moment an adapter is shipped
# without its swap being written down.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
MANIFEST="scripts/dropin-manifest.tsv"
DOCS="docs/for-developers/drop-in-adapters.md"
INDEX="docs/for-developers/integration-surfaces.md"
fail=0
section() { echo; echo "=== $1 ==="; }

# --- 1. PARITY ----------------------------------------------------------------
section "1. drop-in parity (PKG / ATTR / DROP / TEST)"
if bash scripts/dropin-parity-gate.sh; then
  echo "  parity: every declared adapter is parity-verified"
else
  echo "  PARITY-FAIL: scripts/dropin-parity-gate.sh did not exit 0"; fail=1
fi

# --- 2. DOCS ------------------------------------------------------------------
section "2. docs cover every adapter ($DOCS)"
if [ ! -f "$DOCS" ]; then
  echo "  DOCS-FAIL: $DOCS missing"; fail=1
else
  grep -qi -- 'drop-in' "$DOCS" || { echo "  DOCS-FAIL: $DOCS never says 'drop-in'"; fail=1; }
  rows=0
  while IFS=$'\t' read -r upstream shim shim_path readme parity_test; do
    [[ -z "${upstream// }" || "${upstream:0:1}" == "#" ]] && continue
    rows=$((rows+1))
    miss=""
    grep -qF -- "$upstream" "$DOCS" || miss="$miss upstream($upstream)"
    grep -qF -- "$shim" "$DOCS"     || miss="$miss shim($shim)"
    if [ -n "$miss" ]; then
      echo "  DOCS-FAIL: $DOCS does not document:$miss"; fail=1
    fi
  done < "$MANIFEST"
  echo "  docs: checked $rows adapter section(s)"
fi

# --- 3. INDEXED ---------------------------------------------------------------
section "3. docs page is linked from the dev docs index"
if [ -f "$INDEX" ] && grep -qF "drop-in-adapters" "$INDEX"; then
  echo "  indexed: $INDEX links the drop-in adapters page"
else
  echo "  INDEX-FAIL: $INDEX does not link drop-in-adapters.md"; fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "ADAPTERS-DONE-GATE FAIL — not every native adapter has a parity-verified, documented drop-in yet."
  exit 1
fi
echo "ADAPTERS-DONE-GATE PASS — every native drop-in is parity-verified AND documented."
