#!/bin/bash
# verify.sh — honor-path-extract-and-limit-in-unbrowse-mcp-exe
#
# FINDING (wave-1 drive): execute already honors path/extract/limit in
# src/mcp.ts maybePostProcessResult (the callerProjected branch bypasses
# the diet), and dietIfOversize already surfaces a recovery recipe
# (top_level_keys + suggested_limit + next_step) when the wire budget is
# exceeded. The stale memory claiming the 25KB budget ignored these
# params no longer holds. This contract is a REGRESSION GUARD.
#
# Real-channel gate: run the green projection + diet tests.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT"
echo "[verify:exec-projection] bun test projection + diet suites"
bun test tests/mcp-payload-projection.test.ts tests/mcp-projection-diagnostic.test.ts tests/mcp-diet-safety-net-hints.test.ts
