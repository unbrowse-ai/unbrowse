#!/usr/bin/env bash
set -euo pipefail

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/gateway.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/lifecycle.sh"

setup "Unbrowse Replay-v2 E2E (Gateway + Local Correlation Chain)"

MOCK_PID=""
MOCK_LOG="/tmp/oct-replay-v2-mock-$$.log"
PORT_FILE="/tmp/oct-replay-v2-port-$$.txt"

cleanup_all() {
  if [ -n "${MOCK_PID:-}" ] && kill -0 "${MOCK_PID}" 2>/dev/null; then
    kill "${MOCK_PID}" 2>/dev/null || true
    wait "${MOCK_PID}" 2>/dev/null || true
  fi
  teardown
}
trap cleanup_all EXIT

phase "Gateway"
if [ "${OCT_CAN_START_GATEWAY:-0}" = "1" ]; then
  # Best-effort. Some environments already run a supervised gateway.
  gateway_start --auth token --token "${OCT_GATEWAY_TOKEN}" || true
fi
require_gateway
assert_tool_ok "Gateway accepts tool auth" "unbrowse_skills" "{}" "oct" 30

phase "Start Mock API"
rm -f "$PORT_FILE" >/dev/null 2>&1 || true
node "${OCT_FIXTURE_DIR}/replay-v2-mock-server.mjs" --port-file "$PORT_FILE" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

PORT=""
for _ in {1..60}; do
  if [ -s "$PORT_FILE" ]; then
    PORT="$(cat "$PORT_FILE" | tr -d '[:space:]')"
    break
  fi
  sleep 0.1
done
assert "Mock server started" "$([ -n "$PORT" ] && echo true || echo false)"

BASE_URL="http://127.0.0.1:${PORT}"

phase "Write Skill Fixture"
TMP_SKILLS="/tmp/oct-replay-v2-skills-$$"
SERVICE="oct-replay-v2-local"
SKILL_DIR="${TMP_SKILLS}/${SERVICE}"
mkdir -p "${SKILL_DIR}/captures" "${SKILL_DIR}/references"

cat > "${SKILL_DIR}/SKILL.md" << 'MD'
---
name: oct-replay-v2-local
description: OCT fixture skill for replay-v2 chaining (csrf -> submit -> data).
---

# OCT Replay-v2 Local

Endpoints:
- `GET /data`
MD

cat > "${SKILL_DIR}/auth.json" << JSON
{
  "service": "${SERVICE}",
  "baseUrl": "${BASE_URL}",
  "authMethod": "none",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "notes": ["oct fixture"],
  "headers": {},
  "cookies": {}
}
JSON

CAPTURE_FILE="${SKILL_DIR}/captures/session-9999-12-31T00-00-00Z.json"
CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Captured values intentionally differ from runtime server state. Replay must chain and inject.
jq -nc \
  --arg capturedAt "$CAPTURED_AT" \
  --arg seedUrl "${BASE_URL}/start" \
  --arg base "$BASE_URL" \
  '{
    version: 1,
    capturedAt: $capturedAt,
    seedUrl: $seedUrl,
    exchanges: [
      {
        index: 0,
        timestamp: 1,
        request: { method:"GET", url: ($base + "/start"), headers:{}, cookies:{}, queryParams:{} },
        response: {
          status: 200,
          headers: {"content-type":"application/json"},
          cookies: {},
          body: { csrfToken: "csrf_capture" },
          bodyRaw: "{\"csrfToken\":\"csrf_capture\"}",
          bodyFormat: "json",
          contentType: "application/json"
        }
      },
      {
        index: 1,
        timestamp: 2,
        request: {
          method:"POST",
          url: ($base + "/submit"),
          headers: {"x-csrf-token":"csrf_capture","content-type":"application/json"},
          cookies:{},
          queryParams:{},
          body: { hello: "world" },
          bodyRaw: "{\"hello\":\"world\"}",
          bodyFormat: "json",
          contentType: "application/json"
        },
        response: {
          status: 200,
          headers: {"content-type":"application/json"},
          cookies: {},
          body: { sessionId: "sess_capture" },
          bodyRaw: "{\"sessionId\":\"sess_capture\"}",
          bodyFormat: "json",
          contentType: "application/json"
        }
      },
      {
        index: 2,
        timestamp: 3,
        request: {
          method:"GET",
          url: ($base + "/data?sessionId=" + ("sess_capture"|@uri)),
          headers:{},
          cookies:{},
          queryParams:{ sessionId:"sess_capture" }
        },
        response: {
          status: 200,
          headers: {"content-type":"application/json"},
          cookies: {},
          body: { ok: true },
          bodyRaw: "{\"ok\":true}",
          bodyFormat: "json",
          contentType: "application/json"
        }
      }
    ]
  }' > "$CAPTURE_FILE"

assert_file_exists "Capture session written" "$CAPTURE_FILE"

phase "Tool Invocation (unbrowse_replay)"
assert_tool_ok "unbrowse_replay ok" "unbrowse_replay" \
  "$(jq -nc --arg service "$SERVICE" --arg skillsDir "$TMP_SKILLS" '{
    service: $service,
    skillsDir: $skillsDir,
    endpoint: "GET /data",
    executionMode: "node",
    useStealth: false,
    autoChain: true,
    debugReplayV2: true,
    maxResponseChars: 0,
    previewChars: 4000
  }')" \
  "oct" 60

phase "Mock API Metrics"
METRICS_JSON="$(curl -sS "${BASE_URL}/metrics" --max-time 5 || echo '{}')"
START_HITS="$(echo "$METRICS_JSON" | jq -r '.start // 0' 2>/dev/null || echo 0)"
SUBMIT_HITS="$(echo "$METRICS_JSON" | jq -r '.submit // 0' 2>/dev/null || echo 0)"
DATA_HITS="$(echo "$METRICS_JSON" | jq -r '.data // 0' 2>/dev/null || echo 0)"

assert "Start step executed" "$([ "$START_HITS" -ge 1 ] && echo true || echo false)"
assert "Submit step executed" "$([ "$SUBMIT_HITS" -ge 1 ] && echo true || echo false)"
assert "Data step executed" "$([ "$DATA_HITS" -ge 1 ] && echo true || echo false)"

assert_tool_text_contains "Replay-v2 ran target endpoint" "GET /data"
assert_tool_text_contains "Replay-v2 status OK" "→ 200 OK"
assert_tool_text_contains "Replay-v2 response contains ok:true" "\"ok\":true"
assert_tool_text_contains "Replay-v2 passed" "Results: 1 passed, 0 failed"
