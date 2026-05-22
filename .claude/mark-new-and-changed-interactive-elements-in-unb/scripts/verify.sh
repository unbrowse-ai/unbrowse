#!/bin/bash
# verify.sh — mark-new-and-changed-interactive-elements-in-unb
#
# Real-channel gate: run the bun test that exercises the shipped
# markNewSnapElements primitive in src/api/browse-snap-detail-levels.ts
# (wired into the unbrowse_snap handler in src/mcp.ts). Feature shipped in
# commit 74939f24 on branch feat/unbrowse-banger-flash-snap.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT"
echo "[verify:snap-delta] bun test tests/mcp-snap-new-element-marker.test.ts"
bun test tests/mcp-snap-new-element-marker.test.ts
