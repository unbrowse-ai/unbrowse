#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Replay-v2 E2E (Real Network Pack)"

phase "Gateway"
require_gateway
assert_tool_ok "Gateway accepts tool auth" "unbrowse_skills" "{}" "oct" 30

REAL_BASE_URL="${OCT_REAL_BASE_URL:-https://httpbin.org}"

run_case() {
  local label="$1"
  local gen="$2"
  local endpoint="$3"
  local mode="$4"

  phase "Generate Real HAR (${label})"
  local har="/tmp/oct-replay-v2-${label// /-}-$$.har"
  node "${OCT_FIXTURE_DIR}/${gen}" --out "$har" --base-url "$REAL_BASE_URL" >/dev/null
  assert_file_exists "HAR written" "$har"

  phase "Learn Skill (${label})"
  local tmp="/tmp/oct-replay-v2-${label// /-}-skills-$$"
  mkdir -p "$tmp"
  assert_tool_ok "unbrowse_learn ok" "unbrowse_learn" "{\"harPath\":\"${har}\",\"outputDir\":\"${tmp}\"}" "oct" 90
  assert_tool_text_contains "Learn mentions Skill generated" "Skill generated:"

  local service
  service="$(echo "$LAST_TOOL_TEXT" | awk -F': ' '/^Skill generated: /{print $2}' | head -n1 | tr -d '\r')"
  assert "Parsed service name" "$([ -n "$service" ] && echo true || echo false)"

  local skill_dir="${tmp}/${service}"
  assert_file_exists "auth.json exists" "${skill_dir}/auth.json"

phase "Strip Auth Headers (${label})"
node - "${skill_dir}/auth.json" <<'NODE'
const fs = require("fs");
const p = process.argv[2];
const a = JSON.parse(fs.readFileSync(p, "utf8"));
a.headers = {};
fs.writeFileSync(p, JSON.stringify(a, null, 2));
NODE

  phase "Replay Target (${label})"
  assert_tool_ok "unbrowse_replay ok" "unbrowse_replay" \
    "$(jq -nc --arg service "$service" --arg skillsDir "$tmp" --arg endpoint "$endpoint" --arg mode "$mode" '{
      service: $service,
      skillsDir: $skillsDir,
      endpoint: $endpoint,
      executionMode: $mode,
      useStealth: false,
      autoChain: true,
      debugReplayV2: true,
      maxResponseChars: 0,
      previewChars: 2000
    }')" \
    "oct" 120

  assert_tool_text_contains "Replay OK" "→ 200 OK"
  assert_tool_text_contains "Replay passed" "Results: 1 passed, 0 failed"
  assert "Replay-v2 injected non-placeholder value" "$(
    echo "$LAST_TOOL_TEXT" | grep -qi "uuid_placeholder_for_replay_v2" && echo false || echo true
  )"
}

run_case "header-echo" "gen-httpbin-uuid-anything-har.mjs" "GET /anything" "node"
run_case "body-json" "gen-httpbin-uuid-anything-body-har.mjs" "POST /anything" "node"
run_case "query-param" "gen-httpbin-uuid-anything-query-har.mjs" "GET /anything" "node"
run_case "bearer-auth" "gen-httpbin-uuid-anything-bearer-har.mjs" "GET /anything" "node"
run_case "multistep" "gen-httpbin-uuid-anything-multistep-har.mjs" "GET /anything/step2" "node"
