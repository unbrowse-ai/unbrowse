#!/usr/bin/env bash
# openclaw-test-suite: lifecycle.sh — Gateway and test lifecycle
[ -n "${_OCT_LIFECYCLE_LOADED:-}" ] && return 0
_OCT_LIFECYCLE_LOADED=1

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/config.sh"
source "${OCT_LIB_DIR}/health.sh"
source "${OCT_LIB_DIR}/report.sh"

_OCT_GATEWAY_PID=""

setup() {
  local title="${1:-OpenClaw Plugin Test}"
  oct_load_config "${OCT_SUITE_DIR:-$(pwd)}"

  echo "═══════════════════════════════════════════════════════"
  echo " $title"
  echo "═══════════════════════════════════════════════════════"
  echo ""
}

teardown() {
  gateway_stop
  oct_report
}

gateway_start() {
  local log_file="${OCT_GATEWAY_LOG:-/tmp/oct-gateway.log}"
  local timeout_s="${OCT_GATEWAY_START_TIMEOUT:-60}"

  echo "  Starting OpenClaw gateway..."
  openclaw gateway run --allow-unconfigured --dev --force "$@" > "$log_file" 2>&1 &
  _OCT_GATEWAY_PID=$!

  if wait_for_health "${OCT_GATEWAY_URL}/health" "$timeout_s"; then
    assert "Gateway started and healthy" "true"
    return 0
  else
    # Don't let `set -e` abort before we can print the log tail.
    assert "Gateway started and healthy" "false" || true
    warn "Gateway log (last 20 lines):"
    tail -20 "$log_file" 2>/dev/null | sed 's/^/    /' || echo "    (no log)"
    return 1
  fi
}

gateway_stop() {
  if [ -n "$_OCT_GATEWAY_PID" ] && kill -0 "$_OCT_GATEWAY_PID" 2>/dev/null; then
    kill "$_OCT_GATEWAY_PID" 2>/dev/null || true
    wait "$_OCT_GATEWAY_PID" 2>/dev/null || true
    _OCT_GATEWAY_PID=""
  fi
}
