#!/usr/bin/env bash
# openclaw-test-suite: gateway.sh — Tool invocation helpers
[ -n "${_OCT_GATEWAY_LOADED:-}" ] && return 0
_OCT_GATEWAY_LOADED=1

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/config.sh"

invoke_tool() {
  local tool="$1"
  local args="$2"
  local session="${3:-${OCT_SESSION_KEY:-default}}"
  local timeout_s="${4:-${OCT_TOOL_TIMEOUT:-30}}"

  curl -sS "${OCT_GATEWAY_URL}/tools/invoke" \
    -H "Authorization: Bearer ${OCT_GATEWAY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"tool\":\"$tool\",\"args\":$args,\"sessionKey\":\"$session\"}" \
    --max-time "$timeout_s" 2>&1 || echo '{"ok":false,"error":"curl failed"}'
}

tool_ok() {
  echo "$1" | jq -r '.ok // false' 2>/dev/null || echo "false"
}

tool_text() {
  echo "$1" | jq -r '.result.content[0].text // ""' 2>/dev/null || echo ""
}

tool_error() {
  echo "$1" | jq -r '.error.message // .error // "unknown"' 2>/dev/null || echo "unknown"
}

LAST_TOOL_RESPONSE=""
LAST_TOOL_OK=""
LAST_TOOL_TEXT=""
LAST_TOOL_ERROR=""

assert_tool_ok() {
  local desc="$1"
  local tool="$2"
  local args="$3"
  local session="${4:-}"
  local timeout="${5:-}"

  LAST_TOOL_RESPONSE=$(invoke_tool "$tool" "$args" "$session" "$timeout")
  LAST_TOOL_OK=$(tool_ok "$LAST_TOOL_RESPONSE")
  LAST_TOOL_TEXT=$(tool_text "$LAST_TOOL_RESPONSE")
  LAST_TOOL_ERROR=$(tool_error "$LAST_TOOL_RESPONSE")

  assert "$desc" "$([ "$LAST_TOOL_OK" = "true" ] && echo true || echo false)"
  if [ -n "${OCT_VERBOSE:-}" ]; then
    echo "$LAST_TOOL_RESPONSE" | sed 's/^/    /'
  fi
}

assert_tool_text_contains() {
  local desc="$1"
  local needle="$2"
  assert_contains "$desc" "$LAST_TOOL_TEXT" "$needle"
}

