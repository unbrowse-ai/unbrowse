#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Replay-v2 E2E (Popular Apps Stable Pack: Hacker News + StackOverflow)"

phase "Gateway"
require_gateway
assert_tool_ok "Gateway accepts tool auth" "unbrowse_skills" "{}" "oct" 30

REAL_BASE_URL_STACKEXCHANGE="${OCT_REAL_STACKEXCHANGE_BASE_URL:-https://api.stackexchange.com}"
REAL_BASE_URL_HN="${OCT_REAL_HN_BASE_URL:-https://hacker-news.firebaseio.com}"

run_case() {
  local label="$1"
  local gen="$2"
  local endpoint="$3"
  local mode="$4"
  local expect_chain="$5"
  local base_url="$6"

  phase "Generate Real HAR (${label})"
  local har="/tmp/oct-replay-v2-${label// /-}-$$.har"
  if [ -n "${base_url}" ]; then
    node "${OCT_FIXTURE_DIR}/${gen}" --out "$har" --base-url "$base_url" >/dev/null
  else
    node "${OCT_FIXTURE_DIR}/${gen}" --out "$har" >/dev/null
  fi
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
  assert_file_exists "CORRELATIONS.json exists" "${skill_dir}/references/CORRELATIONS.json"
  assert_file_exists "SEQUENCES.json exists" "${skill_dir}/references/SEQUENCES.json"

  # Correlation detection is the core v2 promise: ensure the graph is non-empty.
  assert "CORRELATIONS.json has links" "$(
    links="$(jq -r '.links | length' "${skill_dir}/references/CORRELATIONS.json" 2>/dev/null || echo 0)"
    [ "${links}" -ge 1 ] && echo true || echo false
  )"

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
      previewChars: 1600
    }')" \
    "oct" 120

  assert_tool_text_contains "Replay OK" "→ 200 OK"
  assert_tool_text_contains "Replay passed" "Results: 1 passed, 0 failed"
  assert_tool_text_contains "Replay-v2 chain matches" "${expect_chain}"
}

run_case "hn-topstory-item-user" "gen-hn-topstory-item-user-har.mjs" "GET /v0/user/{id}.json" "node" "chain=0,1,2" "$REAL_BASE_URL_HN"
run_case "so-question-user-chain" "gen-stackoverflow-question-user-chain-har.mjs" "GET /2.3/users/{id}" "node" "chain=0,1,2" "$REAL_BASE_URL_STACKEXCHANGE"
