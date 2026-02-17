#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Replay-v2 E2E (Popular Apps Pack, Browser Mode: GitHub + Hacker News)"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "FAIL: Google Chrome not found at: $CHROME"
  exit 1
fi

pick_port() {
  for p in 9222 9229; do
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

PORT="$(pick_port)" || {
  echo "FAIL: no free port (9222 or 9229) for Chrome remote debugging"
  exit 1
}

PROFILE_DIR="/tmp/oct-chrome-profile-$$"
mkdir -p "$PROFILE_DIR"

cleanup_chrome() {
  kill "${CHROME_PID:-}" 2>/dev/null || true
  wait "${CHROME_PID:-}" 2>/dev/null || true
  rm -rf "$PROFILE_DIR" 2>/dev/null || true
}
trap cleanup_chrome EXIT

phase "Start Headless Chrome (CDP)"
"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!

for _ in {1..80}; do
  curl -fsS "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 && break
  sleep 0.1
done

phase "Gateway"
require_gateway
assert_tool_ok "Gateway accepts tool auth" "unbrowse_skills" "{}" "oct" 30

run_case() {
  local label="$1"
  local gen="$2"
  local endpoint="$3"
  local expect_chain="$4"

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
    "$(jq -nc --arg service "$service" --arg skillsDir "$tmp" --arg endpoint "$endpoint" --arg cdpPort "$PORT" '{
      service: $service,
      skillsDir: $skillsDir,
      endpoint: $endpoint,
      executionMode: "browser",
      useStealth: false,
      autoChain: true,
      debugReplayV2: true,
      maxResponseChars: 0,
      previewChars: 1200
    }')" \
    "oct" 120

  assert_tool_text_contains "Replay uses browser transport" "Using browser"
  assert_tool_text_contains "Replay OK" "→ 200 OK"
  assert_tool_text_contains "Replay passed" "Results: 1 passed, 0 failed"
  assert_tool_text_contains "Replay-v2 chain matches" "${expect_chain}"
}

# GitHub browser-mode calls are rate-limited aggressively on shared NAT egress.
# Keep this suite focused on the browser transport + chaining signal using HN.
run_case "hn-topstory-item-user" "gen-hn-topstory-item-user-har.mjs" "GET /v0/user/{id}.json" "chain=0,1,2"
