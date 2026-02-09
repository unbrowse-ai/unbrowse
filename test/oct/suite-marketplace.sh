#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Marketplace E2E (Gateway + Real Index)"

if [ "${OCT_CAN_START_GATEWAY:-0}" != "1" ]; then
  phase "Skip"
  skip "suite-marketplace requires starting an ephemeral gateway (set OCT_CAN_START_GATEWAY=1 or run via test:oct:docker)"
  teardown
  exit 0
fi

cleanup_all() { teardown; }
trap cleanup_all EXIT

phase "Marketplace"
: "${UNBROWSE_INDEX_URL:=http://127.0.0.1:4112}"
check_service "Marketplace" "${UNBROWSE_INDEX_URL}" "/health" "true"

phase "Start Gateway"
gateway_start --auth token --token "${OCT_GATEWAY_TOKEN}"
require_gateway

phase "Generate Skill (unbrowse_learn)"
TMP_SKILLS="${OCT_TMP_SKILLS_DIR:-/tmp/oct-skills-$$}"
mkdir -p "$TMP_SKILLS"
assert_tool_ok "unbrowse_learn ok" "unbrowse_learn" "{\"harPath\":\"${OCT_FIXTURE_DIR}/example.har\",\"outputDir\":\"${TMP_SKILLS}\"}" "oct" 60
assert_tool_text_contains "Learn mentions Skill generated" "Skill generated:"

SERVICE="$(ls -1 "$TMP_SKILLS" | head -n 1)"
assert "Skill directory created" "$([ -n "$SERVICE" ] && [ -d "$TMP_SKILLS/$SERVICE" ] && echo true || echo false)"

phase "Publish Skill (unbrowse_publish)"
assert_tool_ok "unbrowse_publish ok" "unbrowse_publish" "{\"service\":\"${SERVICE}\",\"skillsDir\":\"${TMP_SKILLS}\",\"price\":\"0\"}" "oct" 60
assert_tool_text_contains "Publish prints ID" "^ID: "
SKILL_ID="$(echo "$LAST_TOOL_TEXT" | awk -F': ' '/^ID: /{print $2}' | head -n1)"
assert "Parsed published skill ID" "$([ -n "$SKILL_ID" ] && echo true || echo false)"

phase "Search Skill (unbrowse_search)"
assert_tool_ok "unbrowse_search ok" "unbrowse_search" "{\"query\":\"${SERVICE}\"}" "oct" 60
assert_tool_text_contains "Search shows results" "Skill Marketplace"
assert_tool_text_contains "Search shows ID" "$SKILL_ID"

phase "Install Skill (unbrowse_search install)"
assert_tool_ok "unbrowse_search install ok" "unbrowse_search" "{\"install\":\"${SKILL_ID}\"}" "oct" 60
assert_tool_text_contains "Install prints location" "^Location: "

INSTALLED_DIR="${HOME}/.openclaw/skills/${SERVICE}"
assert_file_exists "Installed SKILL.md" "${INSTALLED_DIR}/SKILL.md"
assert_file_exists "Installed auth.json" "${INSTALLED_DIR}/auth.json"
