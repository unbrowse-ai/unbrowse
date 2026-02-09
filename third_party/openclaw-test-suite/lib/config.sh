#!/usr/bin/env bash
# openclaw-test-suite: config.sh — Configuration loading
[ -n "${_OCT_CONFIG_LOADED:-}" ] && return 0
_OCT_CONFIG_LOADED=1

: "${OCT_GATEWAY_URL:=http://127.0.0.1:18789}"
: "${OCT_GATEWAY_TOKEN:=}"
: "${OCT_GATEWAY_LOG:=/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log}"
: "${OCT_BROWSER_PORT:=18791}"
: "${OCT_SKILLS_DIR:=$HOME/.openclaw/skills}"
: "${OCT_PLUGIN_DIR:=}"
: "${OCT_PLUGIN_ID:=}"
: "${OCT_MARKETPLACE_URL:=}"
: "${OCT_SESSION_KEY:=test}"
: "${OCT_TOOL_TIMEOUT:=30}"
: "${OCT_FIXTURE_DIR:=}"
: "${OCT_OUTPUT_FORMAT:=pretty}"
: "${OCT_TRACE_PREFIX:=}"
: "${OCT_SUITE_DIR:=$(pwd)}"

oct_load_config() {
  local suite_dir="${1:-${OCT_SUITE_DIR}}"
  OCT_SUITE_DIR="$suite_dir"

  if [ -f "${suite_dir}/oct.env" ]; then
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$key" ]] && continue
      key=$(echo "$key" | xargs)
      value=$(echo "$value" | xargs)
      value="${value//\$HOME/$HOME}"
      value="${value/#\~/$HOME}"
      if [ -z "${!key:-}" ]; then
        export "$key=$value"
      fi
    done < "${suite_dir}/oct.env"
  fi

  if [ -f "${suite_dir}/oct.json" ] && command -v jq &>/dev/null; then
    local json="${suite_dir}/oct.json"
    _oct_json_default "OCT_GATEWAY_URL" ".gateway.url" "$json"
    _oct_json_default "OCT_GATEWAY_TOKEN" ".gateway.token" "$json"
    _oct_json_default "OCT_PLUGIN_ID" ".plugin.id" "$json"
    _oct_json_default "OCT_PLUGIN_DIR" ".plugin.dir" "$json"
    _oct_json_default "OCT_MARKETPLACE_URL" ".services.marketplace.url" "$json"
    _oct_json_default "OCT_BROWSER_PORT" ".services.browser.port" "$json"
  fi

  [ -z "${OCT_FIXTURE_DIR:-}" ] && OCT_FIXTURE_DIR="${suite_dir}/fixtures"

  if [ -z "${OCT_GATEWAY_TOKEN:-}" ] && [ -f "$HOME/.openclaw/openclaw.json" ] && command -v jq &>/dev/null; then
    OCT_GATEWAY_TOKEN=$(jq -r '.gateway.auth.token // empty' "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo "")
  fi
}

_oct_json_default() {
  local var="$1" path="$2" file="$3"
  if [ -z "${!var:-}" ]; then
    local val
    val=$(jq -r "$path // empty" "$file" 2>/dev/null || echo "")
    val="${val/#\~/$HOME}"
    val="${val//\$HOME/$HOME}"
    [ -n "$val" ] && export "$var=$val"
  fi
}

