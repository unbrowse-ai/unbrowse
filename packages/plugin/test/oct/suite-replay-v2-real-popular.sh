#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Replay-v2 E2E (Popular Apps Pack: GitHub + Hacker News)"

phase "Gateway"
require_gateway
assert_tool_ok "Gateway accepts tool auth" "unbrowse_skills" "{}" "oct" 30

run_case() {
  local label="$1"
  local gen="$2"
  local endpoint="$3"
  local mode="$4"
  local expect_chain="$5"

  phase "Generate Real HAR (${label})"
  local har="/tmp/oct-replay-v2-${label// /-}-$$.har"
  node "${OCT_FIXTURE_DIR}/${gen}" --out "$har" >/dev/null
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
  if [ -n "${expect_chain}" ]; then
    assert_tool_text_contains "Replay-v2 chain matches" "${expect_chain}"
  fi
  assert "Replay-v2 injected non-placeholder value" "$(
    echo "$LAST_TOOL_TEXT" | rg -qi "placeholder_for_replay_v2" && echo false || echo true
  )"
}

# GitHub: response-body -> path injection (user login -> repos path)
# NOTE: endpoint path is a template to match the captured placeholder path.
run_case "github-user-repos" "gen-github-user-repos-har.mjs" "GET /users/{login}/repos" "node" "chain=0,1"

# GitHub: response-body -> request-body injection (gist id -> markdown POST body)
run_case "github-gist-markdown" "gen-github-gist-markdown-har.mjs" "POST /markdown" "node" "chain=0,1"

# Hacker News: 3-step chain (topstories -> item -> user), all JSON
run_case "hn-topstory-item-user" "gen-hn-topstory-item-user-har.mjs" "GET /v0/user/{id}.json" "node" "chain=0,1,2"

# StackOverflow: 3-step chain (questions -> question -> user)
run_case "so-question-user-chain" "gen-stackoverflow-question-user-chain-har.mjs" "GET /2.3/users/{id}" "node" "chain=0,1,2"
