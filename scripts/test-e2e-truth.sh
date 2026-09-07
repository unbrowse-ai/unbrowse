#!/usr/bin/env bash
set -euo pipefail

echo "[truth] cli"
bun test tests/cli-e2e.test.ts tests/cli-input-payload.test.ts --timeout 120000

echo "[truth] routing telemetry"
bun test tests/cli-routing-telemetry.e2e.test.ts --timeout 180000

echo "[truth] kuri"
bun test tests/kuri-e2e.test.ts --timeout 120000

# tests/p0-p1-issues.test.ts referenced here historically; the file was
# removed and bun test fuzz-matches missing names against other test
# files, so keeping the line silently ran the wrong tests. Removed
# 2026-05-22. If the p0-p1 coverage needs to come back, restore the
# test file alongside this line.
echo "[truth] graph"
bun test backend/tests/graph-edges-route.test.ts backend/tests/graph-api.test.ts --timeout 120000
