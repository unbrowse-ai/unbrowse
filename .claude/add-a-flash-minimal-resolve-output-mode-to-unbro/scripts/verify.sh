#!/bin/bash
# verify.sh — add-a-flash-minimal-resolve-output-mode-to-unbro
#
# Real-channel gate: run the bun test that exercises the shipped
# applyFlashMode primitive in src/mcp.ts. The feature shipped in
# commit 464b20ec on branch feat/resolve-flash-mode.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT"
echo "[verify:flash-mode] bun test tests/mcp-resolve-flash-mode.test.ts"
bun test tests/mcp-resolve-flash-mode.test.ts
