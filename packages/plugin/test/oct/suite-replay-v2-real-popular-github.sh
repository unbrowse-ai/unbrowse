#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Replay-v2 E2E (Popular Apps Pack: GitHub, Requires GITHUB_TOKEN)"

phase "Gateway"
require_gateway
assert_tool_ok "Gateway accepts tool auth" "unbrowse_skills" "{}" "oct" 30

TOKEN="${GITHUB_TOKEN:-${OCT_GITHUB_TOKEN:-}}"
if [ -z "${TOKEN}" ]; then
  echo "FAIL: missing GITHUB_TOKEN (or OCT_GITHUB_TOKEN) for authenticated GitHub API calls"
  exit 2
fi

run_case() {
  local label="$1"
  local gen="$2"
  local endpoint="$3"
  local mode="$4"
  local expect_chain="$5"

  phase "Generate Real HAR (${label})"
  local har="/tmp/oct-replay-v2-${label// /-}-$$.har"
  node "${OCT_FIXTURE_DIR}/${gen}" --out "$har" --token "$TOKEN" >/dev/null
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
      previewChars: 1200
    }')" \
    "oct" 120

  assert_tool_text_contains "Replay OK" "→ 200 OK"
  assert_tool_text_contains "Replay passed" "Results: 1 passed, 0 failed"
  assert_tool_text_contains "Replay-v2 chain matches" "${expect_chain}"
}

run_case "github-user-repos" "gen-github-user-repos-har.mjs" "GET /users/{login}/repos" "node" "chain=0,1"
run_case "github-gist-markdown" "gen-github-gist-markdown-har.mjs" "POST /markdown" "node" "chain=0,1"
