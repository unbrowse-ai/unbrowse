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
assert_tool_text_contains "Publish prints ID" "ID: "
SKILL_ID="$(echo "$LAST_TOOL_TEXT" | awk -F': ' '/^ID: /{print $2}' | head -n1)"
assert "Parsed published skill ID" "$([ -n "$SKILL_ID" ] && echo true || echo false)"

phase "Search Skill (unbrowse_search)"
SEARCH_TEXT=""
for i in {1..15}; do
  RESP="$(invoke_tool "unbrowse_search" "{\"query\":\"${SERVICE}\"}" "oct" 60)"
  OK="$(tool_ok "$RESP")"
  SEARCH_TEXT="$(tool_text "$RESP")"
  if [ "$OK" != "true" ]; then
    LAST_TOOL_RESPONSE="$RESP"
    LAST_TOOL_OK="$OK"
    LAST_TOOL_TEXT="$SEARCH_TEXT"
    LAST_TOOL_ERROR="$(tool_error "$RESP")"
    assert_tool_ok "unbrowse_search ok" "unbrowse_search" "{\"query\":\"${SERVICE}\"}" "oct" 60
  fi
  echo "$SEARCH_TEXT" | grep -q "$SKILL_ID" && break
  sleep 2
done
if echo "$SEARCH_TEXT" | grep -q "$SKILL_ID"; then
  assert_contains "Search shows ID" "$SEARCH_TEXT" "$SKILL_ID"
else
  warn "Search did not return published skill ID (may be eventually consistent); continuing"
fi

phase "Install Skill (unbrowse_search install)"
assert_tool_ok "unbrowse_search install ok" "unbrowse_search" "{\"install\":\"${SKILL_ID}\"}" "oct" 60

INSTALLED_DIR="${OCT_SKILLS_DIR}/${SERVICE}"
assert_file_exists "Installed SKILL.md" "${INSTALLED_DIR}/SKILL.md"
assert_file_exists "Installed auth.json" "${INSTALLED_DIR}/auth.json"

phase "Execution Gate (backend) + Receipt Settle"
# Fetch one endpoint so we can gate a concrete method+url pair.
EP_JSON="$(curl -sf "${UNBROWSE_INDEX_URL}/marketplace/skills/${SKILL_ID}/endpoints" --max-time 15)"
EP_ID="$(echo "$EP_JSON" | jq -r '.endpoints[0].endpointId // empty')"
EP_METHOD="$(echo "$EP_JSON" | jq -r '.endpoints[0].method // empty')"
EP_DOMAIN="$(echo "$EP_JSON" | jq -r '.endpoints[0].domain // empty')"
EP_PATH="$(echo "$EP_JSON" | jq -r '.endpoints[0].rawPath // .endpoints[0].normalizedPath // empty')"
assert "Got endpointId for gating" "$([ -n "$EP_ID" ] && echo true || echo false)"
assert "Got method for gating" "$([ -n "$EP_METHOD" ] && echo true || echo false)"
assert "Got domain for gating" "$([ -n "$EP_DOMAIN" ] && echo true || echo false)"
assert "Got path for gating" "$([ -n "$EP_PATH" ] && echo true || echo false)"

TARGET_URL="https://${EP_DOMAIN}${EP_PATH}"
GATE_JSON="$(curl -sf -X POST "${UNBROWSE_INDEX_URL}/marketplace/execution-gate" \
  -H "content-type: application/json" \
  --data "$(jq -nc --arg skillId "$SKILL_ID" --arg method "$EP_METHOD" --arg url "$TARGET_URL" '{skillId:$skillId,method:$method,url:$url}')" \
  --max-time 15)"
GATE_OK="$(echo "$GATE_JSON" | jq -r '.success // false')"
assert_eq "execution-gate ok" "$GATE_OK" "true"
RUN_TOKEN="$(echo "$GATE_JSON" | jq -r '.runToken // empty')"
EXECUTE_URL="$(echo "$GATE_JSON" | jq -r '.executeUrl // empty')"
assert "execution-gate returns runToken" "$([ -n "$RUN_TOKEN" ] && echo true || echo false)"
assert "execution-gate returns executeUrl" "$([ -n "$EXECUTE_URL" ] && echo true || echo false)"

SETTLE_JSON="$(curl -sf -X POST "${UNBROWSE_INDEX_URL}/marketplace/executions" \
  -H "content-type: application/json" \
  --data "$(jq -nc --arg runToken "$RUN_TOKEN" '{runToken:$runToken,success:true,statusCode:200,executionTimeMs:5,metadata:{outputFingerprint:"oct",outputSummary:"oct receipt"}}')" \
  --max-time 15)"
SETTLE_OK="$(echo "$SETTLE_JSON" | jq -r '.success // false')"
assert_eq "execution receipt settle ok" "$SETTLE_OK" "true"

phase "Deprecated Execute Route (410)"
STATUS="$(curl -sS -o /dev/null -w "%{http_code}" -X POST "${UNBROWSE_INDEX_URL}/marketplace/endpoints/${EP_ID}/execute" \
  -H "content-type: application/json" --data '{}' --max-time 15 || echo "000")"
assert_eq "legacy /execute is 410" "$STATUS" "410"
