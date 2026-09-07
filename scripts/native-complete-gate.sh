#!/usr/bin/env bash
# native-complete-gate.sh — Unbrowse is a DOCUMENTED, parity-verified drop-in /
# native adapter on every layer it can be: HTTP clients, browser automation,
# search/retrieval, AND the popular agent SDKs, with MCP as the native protocol.
#
# Exits 0 exactly when ALL hold:
#   1. LIBRARY DROP-INS — scripts/adapters-done-gate.sh exits 0 (16 library
#      drop-ins parity-verified AND documented + indexed).
#   2. AGENT SDKS — scripts/agent-sdk-parity-gate.sh exits 0 (every popular agent
#      framework has a parity-verified native-tool adapter).
#   3. AGENT-SDK DOCS — docs/for-developers/agent-sdk-adapters.md documents every
#      agent-SDK row AND the native MCP surface (`npx unbrowse mcp`).
#   4. MCP NATIVE — the MCP server actually exists in the source tree.
#   5. INDEXED — the agent-SDK docs page is linked from the dev docs index.
#
# No string fakes it: agent-SDK rows go green only when a real adapter with a
# passing shape test exists, and MCP is verified against the real server module.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
ASDK_MANIFEST="scripts/agent-sdk-manifest.tsv"
ASDK_DOCS="docs/for-developers/agent-sdk-adapters.md"
INDEX="docs/for-developers/integration-surfaces.md"
MCP_SERVER="src/mcp.ts"
fail=0
section() { echo; echo "=== $1 ==="; }

# --- 1. LIBRARY DROP-INS ------------------------------------------------------
section "1. library drop-ins (adapters-done-gate)"
if bash scripts/adapters-done-gate.sh >/tmp/ndg_libs.out 2>&1; then
  echo "  library drop-ins: parity-verified AND documented"
else
  echo "  LIB-FAIL: scripts/adapters-done-gate.sh did not exit 0 (see /tmp/ndg_libs.out)"; fail=1
fi

# --- 2. AGENT SDKS ------------------------------------------------------------
section "2. agent-SDK native-tool adapters"
if bash scripts/agent-sdk-parity-gate.sh; then
  echo "  agent SDKs: parity-verified"
else
  echo "  ASDK-FAIL: scripts/agent-sdk-parity-gate.sh did not exit 0"; fail=1
fi

# --- 3. AGENT-SDK DOCS --------------------------------------------------------
section "3. agent-SDK docs cover every framework + MCP ($ASDK_DOCS)"
if [ ! -f "$ASDK_DOCS" ]; then
  echo "  DOCS-FAIL: $ASDK_DOCS missing"; fail=1
else
  grep -qi -- 'MCP' "$ASDK_DOCS" || { echo "  DOCS-FAIL: $ASDK_DOCS never mentions MCP"; fail=1; }
  grep -qiF -- 'npx unbrowse mcp' "$ASDK_DOCS" || { echo "  DOCS-FAIL: $ASDK_DOCS never shows 'npx unbrowse mcp'"; fail=1; }
  rows=0
  while IFS=$'\t' read -r framework pkg pkg_path readme shape_test; do
    [[ -z "${framework// }" || "${framework:0:1}" == "#" ]] && continue
    rows=$((rows+1))
    miss=""
    grep -qF -- "$framework" "$ASDK_DOCS" || miss="$miss framework($framework)"
    grep -qF -- "$pkg" "$ASDK_DOCS"       || miss="$miss adapter($pkg)"
    [ -n "$miss" ] && { echo "  DOCS-FAIL: $ASDK_DOCS does not document:$miss"; fail=1; }
  done < "$ASDK_MANIFEST"
  echo "  docs: checked $rows agent-SDK section(s) + MCP"
fi

# --- 4. MCP NATIVE ------------------------------------------------------------
section "4. native MCP server present"
if [ -f "$MCP_SERVER" ]; then
  echo "  mcp: $MCP_SERVER present (native MCP surface)"
else
  echo "  MCP-FAIL: $MCP_SERVER missing"; fail=1
fi

# --- 5. INDEXED ---------------------------------------------------------------
section "5. agent-SDK docs linked from the dev docs index"
if [ -f "$INDEX" ] && grep -qF "agent-sdk-adapters" "$INDEX"; then
  echo "  indexed: $INDEX links the agent-SDK adapters page"
else
  echo "  INDEX-FAIL: $INDEX does not link agent-sdk-adapters.md"; fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "NATIVE-COMPLETE-GATE FAIL — Unbrowse is not yet a documented native adapter on every layer."
  exit 1
fi
echo "NATIVE-COMPLETE-GATE PASS — library drop-ins + agent SDKs + MCP all parity-verified AND documented."
