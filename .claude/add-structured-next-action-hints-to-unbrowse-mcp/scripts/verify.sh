#!/bin/bash
# verify.sh — add-structured-next-action-hints-to-unbrowse-mcp
#
# FINDING (wave-1 drive): the structured next_action object already ships
# in src/mcp.ts (addExecuteNextStepHints L1528, addCaptureNextStepHints
# L1560, addGoNextStepHints L1599 — each emits next_action:{title,command,
# command_args,why}). The CLAUDE.md "Known Issues" line claiming hints are
# prose-only was stale. This contract is therefore a REGRESSION GUARD over
# the shipped feature, not a build task.
#
# Real-channel gate: run the green next_action test. NOTE: the dedicated
# tests/mcp-next-action-shape.test.ts is pre-existing-broken (imports a
# non-existent export addResolveHitGuidance) — fixing that stale import is
# this contract's one remaining cleanup; mcp-go-next-action.test.ts proves
# the feature itself ships.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT"
echo "[verify:next-action] bun test tests/mcp-go-next-action.test.ts"
bun test tests/mcp-go-next-action.test.ts
