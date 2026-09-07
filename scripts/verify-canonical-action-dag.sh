#!/usr/bin/env bash
set -euo pipefail

bun test \
  tests/run-planner.test.ts \
  tests/passive-publish.test.ts \
  tests/cli-setup-flow.test.ts \
  tests/mcp-resolve-miss-no-match-status.test.ts \
  tests/mcp-resolve-guidance.test.ts

test "$(rg -l 'isEvidenceBackedReadEndpoint' src/cli.ts src/orchestrator/index.ts | wc -l)" -eq 2
rg -q 'publishAfterIndex: true' src/orchestrator/index.ts
rg -q 'await queuePassiveSkillPublish\(skill\)' src/api/routes.ts
rg -q 'explicit_opt_out' src/orchestrator/passive-publish.ts
rg -q 'unbrowse_breath_get' src/mcp.ts

echo "canonical action DAG witness: PASS"
