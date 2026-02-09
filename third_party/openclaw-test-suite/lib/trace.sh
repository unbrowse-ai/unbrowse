#!/usr/bin/env bash
# openclaw-test-suite: trace.sh — Gateway log telemetry
[ -n "${_OCT_TRACE_LOADED:-}" ] && return 0
_OCT_TRACE_LOADED=1

source "${OCT_LIB_DIR}/config.sh"

oct_trace() {
  local minutes="${1:-10}"
  local session_pat="${2:-}"
  local errors_only="${3:-false}"
  local log_file="${OCT_GATEWAY_LOG:-/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log}"

  echo " OpenClaw Gateway Trace — last ${minutes}min"
  echo " Log: $log_file"
  echo ""

  if [ ! -f "$log_file" ]; then
    echo "No gateway log found."
    return 0
  fi

  # Best-effort tail; this is intentionally simple to keep dependency surface tiny.
  local lines=$((minutes * 200))
  local data
  data=$(tail -n "$lines" "$log_file" 2>/dev/null || true)

  if [ -n "$session_pat" ]; then
    data=$(echo "$data" | grep -iE "$session_pat" || true)
  fi

  if [ "$errors_only" = "true" ]; then
    data=$(echo "$data" | grep -iE "error|exception|fail" || true)
  fi

  echo "$data"
}

