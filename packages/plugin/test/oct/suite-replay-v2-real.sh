#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Replay-v2 E2E (Real Network: httpbin uuid -> anything)"

phase "Gateway"
require_gateway
assert_tool_ok "Gateway accepts tool auth" "unbrowse_skills" "{}" "oct" 30

REAL_BASE_URL="${OCT_REAL_BASE_URL:-https://httpbin.org}"

phase "Generate Real HAR (httpbin)"
HAR_PATH="/tmp/oct-replay-v2-real-$$.har"
node "${OCT_FIXTURE_DIR}/gen-httpbin-uuid-anything-har.mjs" --out "$HAR_PATH" --base-url "$REAL_BASE_URL" >/dev/null
assert_file_exists "HAR written" "$HAR_PATH"

phase "Learn Skill (unbrowse_learn)"
TMP_SKILLS="/tmp/oct-replay-v2-real-skills-$$"
mkdir -p "$TMP_SKILLS"
assert_tool_ok "unbrowse_learn ok" "unbrowse_learn" "{\"harPath\":\"${HAR_PATH}\",\"outputDir\":\"${TMP_SKILLS}\"}" "oct" 90
assert_tool_text_contains "Learn mentions Skill generated" "Skill generated:"

SERVICE="$(echo "$LAST_TOOL_TEXT" | awk -F': ' '/^Skill generated: /{print $2}' | head -n1 | tr -d '\r')"
assert "Parsed service name" "$([ -n "$SERVICE" ] && echo true || echo false)"

SKILL_DIR="${TMP_SKILLS}/${SERVICE}"
assert_file_exists "auth.json exists" "${SKILL_DIR}/auth.json"
assert_file_exists "capture exists" "${SKILL_DIR}/captures/$(ls -1 "${SKILL_DIR}/captures" | tail -n1)"

phase "Strip Auth Headers (force chaining)"
# Ensure replay cannot succeed via static auth.json headers.
node - "${SKILL_DIR}/auth.json" <<'NODE'
const fs = require("fs");
const p = process.argv[2];
const a = JSON.parse(fs.readFileSync(p, "utf8"));
a.headers = {};
fs.writeFileSync(p, JSON.stringify(a, null, 2));
NODE

phase "Replay Target (unbrowse_replay)"
assert_tool_ok "unbrowse_replay ok" "unbrowse_replay" \
  "$(jq -nc --arg service "$SERVICE" --arg skillsDir "$TMP_SKILLS" '{
    service: $service,
    skillsDir: $skillsDir,
    endpoint: "GET /anything",
    executionMode: "node",
    useStealth: false,
    autoChain: true,
    debugReplayV2: true,
    maxResponseChars: 0,
    previewChars: 2000
  }')" \
  "oct" 90

assert_tool_text_contains "Replay OK" "→ 200 OK"
assert_tool_text_contains "Replay passed" "Results: 1 passed, 0 failed"
assert_tool_text_contains "Replay-v2 planned chain" "chain=0,1"
assert_tool_text_contains "Replay-v2 target idx" "targetIdx=1"
assert "Replay-v2 injected non-placeholder header" "$(
  echo "$LAST_TOOL_TEXT" | grep -qi "uuid_placeholder_for_replay_v2" && echo false || echo true
)"
