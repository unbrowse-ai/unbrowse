#!/usr/bin/env bash
# everywhere-gate.sh — Unbrowse is a DOCUMENTED, parity-verified drop-in / native
# adapter on every layer it can reach, in every runtime that needs it: the JS
# ecosystem (HTTP clients, browser automation, search, agent SDKs) + MCP, AND the
# Python layer below it (HTTP clients + agent SDKs).
#
# Exits 0 exactly when ALL hold:
#   1. JS + MCP    — scripts/native-complete-gate.sh exits 0 (16 lib drop-ins +
#      5 agent SDKs + MCP, all parity-verified AND documented).
#   2. PYTHON      — scripts/python-adapter-gate.sh exits 0 (every popular Python
#      library has a parity-verified adapter).
#   3. PYTHON DOCS — docs/for-developers/python-adapters.md documents every Python
#      adapter row (upstream + package).
#   4. INDEXED     — that page is linked from the dev docs index.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
PY_MANIFEST="scripts/python-adapter-manifest.tsv"
PY_DOCS="docs/for-developers/python-adapters.md"
INDEX="docs/for-developers/integration-surfaces.md"
fail=0
section() { echo; echo "=== $1 ==="; }

# --- 1. JS + MCP --------------------------------------------------------------
section "1. JS ecosystem + MCP (native-complete-gate)"
if bash scripts/native-complete-gate.sh >/tmp/ew_js.out 2>&1; then
  echo "  JS libraries + agent SDKs + MCP: parity-verified AND documented"
else
  echo "  JS-FAIL: scripts/native-complete-gate.sh did not exit 0 (see /tmp/ew_js.out)"; fail=1
fi

# --- 2. PYTHON ----------------------------------------------------------------
section "2. Python-layer adapters"
if bash scripts/python-adapter-gate.sh; then
  echo "  Python adapters: parity-verified"
else
  echo "  PY-FAIL: scripts/python-adapter-gate.sh did not exit 0"; fail=1
fi

# --- 3. PYTHON DOCS -----------------------------------------------------------
section "3. Python docs cover every adapter ($PY_DOCS)"
if [ ! -f "$PY_DOCS" ]; then
  echo "  DOCS-FAIL: $PY_DOCS missing"; fail=1
else
  rows=0
  while IFS=$'\t' read -r upstream pkg pkg_dir readme test; do
    [[ -z "${upstream// }" || "${upstream:0:1}" == "#" ]] && continue
    rows=$((rows+1))
    miss=""
    grep -qF -- "$upstream" "$PY_DOCS" || miss="$miss upstream($upstream)"
    grep -qF -- "$pkg" "$PY_DOCS"      || miss="$miss pkg($pkg)"
    [ -n "$miss" ] && { echo "  DOCS-FAIL: $PY_DOCS does not document:$miss"; fail=1; }
  done < "$PY_MANIFEST"
  echo "  docs: checked $rows Python adapter section(s)"
fi

# --- 4. INDEXED ---------------------------------------------------------------
section "4. Python docs linked from the dev docs index"
if [ -f "$INDEX" ] && grep -qF "python-adapters" "$INDEX"; then
  echo "  indexed: $INDEX links the Python adapters page"
else
  echo "  INDEX-FAIL: $INDEX does not link python-adapters.md"; fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "EVERYWHERE-GATE FAIL — Unbrowse is not yet a documented native adapter on every layer + runtime."
  exit 1
fi
echo "EVERYWHERE-GATE PASS — JS + MCP + Python: every reachable layer is a parity-verified, documented adapter."
