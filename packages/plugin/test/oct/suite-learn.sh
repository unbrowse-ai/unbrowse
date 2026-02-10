#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Learn E2E (Existing Gateway)"

if [ "${OCT_CAN_START_GATEWAY:-0}" = "1" ]; then
  phase "Skip"
  skip "suite-learn targets an already running gateway; docker/CI uses suite-marketplace which covers learn"
  teardown
  exit 0
fi

phase "Gateway"
require_gateway

phase "Tool Invocation (unbrowse_learn)"
OUT_DIR="/tmp/oct-learn-skills-$$"
mkdir -p "$OUT_DIR"

assert_tool_ok "unbrowse_learn ok" "unbrowse_learn" "{\"harPath\":\"${OCT_FIXTURE_DIR}/example.har\",\"outputDir\":\"${OUT_DIR}\"}" "oct" 60
assert_tool_text_contains "Learn mentions Skill generated" "Skill generated:"
assert_tool_text_contains "Learn mentions Endpoints" "Endpoints:"

teardown
