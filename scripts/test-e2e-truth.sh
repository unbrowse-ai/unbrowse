#!/usr/bin/env bash
set -euo pipefail

echo "[truth] cli"
bun test tests/cli-e2e.test.ts tests/cli-input-payload.test.ts --timeout 120000

echo "[truth] routing telemetry"
bun test tests/cli-routing-telemetry.e2e.test.ts --timeout 180000

echo "[truth] kuri"
bun test tests/kuri-e2e.test.ts --timeout 120000

echo "[truth] p0-p1"
bun test tests/p0-p1-issues.test.ts --timeout 120000

echo "[truth] graph"
bun test backend/tests/graph-edges-route.test.ts backend/tests/graph-api.test.ts --timeout 120000
