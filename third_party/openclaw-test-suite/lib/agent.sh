#!/usr/bin/env bash
# openclaw-test-suite: agent.sh — LLM agent subprocess management
[ -n "${_OCT_AGENT_LOADED:-}" ] && return 0
_OCT_AGENT_LOADED=1

source "${OCT_LIB_DIR}/core.sh"

# Minimal subset. This repo currently doesn't rely on agent-mode E2E.

agent_run() {
  local desc="$1"
  local prompt="$2"
  local timeout_s="${3:-120}"

  assert "$desc" "true"
  timeout -k 5 "$timeout_s" openclaw agent --local -p "$prompt" >/tmp/oct-agent.out 2>/tmp/oct-agent.err || true
}

