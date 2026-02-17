#!/usr/bin/env bash
# openclaw-test-suite: health.sh — Service health checks
[ -n "${_OCT_HEALTH_LOADED:-}" ] && return 0
_OCT_HEALTH_LOADED=1

source "${OCT_LIB_DIR}/core.sh"
source "${OCT_LIB_DIR}/config.sh"

_OCT_LAST_CHECK=""

_oct_tcp_open() {
  local url="$1"
  local host port
  host="$(echo "$url" | sed -n 's#^[a-zA-Z]*://\\([^:/]*\\).*#\\1#p')"
  port="$(echo "$url" | sed -n 's#.*:\\([0-9][0-9]*\\).*#\\1#p')"
  [ -z "${host:-}" ] && host="127.0.0.1"
  [ -z "${port:-}" ] && port="18789"
  timeout 1 bash -c ">/dev/tcp/${host}/${port}" >/dev/null 2>&1
}

check_gateway() {
  local do_assert="${1:-true}"
  local auth_args=()
  [ -n "${OCT_GATEWAY_TOKEN:-}" ] && auth_args=(-H "Authorization: Bearer ${OCT_GATEWAY_TOKEN}")
  if curl -sf -o /dev/null "${OCT_GATEWAY_URL}/health" --max-time 5 "${auth_args[@]}" 2>/dev/null; then
    _OCT_LAST_CHECK="ok"
  elif curl -sf -o /dev/null "${OCT_GATEWAY_URL}/" --max-time 5 "${auth_args[@]}" 2>/dev/null; then
    # Some OpenClaw builds serve the Control UI but do not expose /health over HTTP.
    _OCT_LAST_CHECK="ok"
  elif _oct_tcp_open "${OCT_GATEWAY_URL}"; then
    # Last resort: TCP open means the gateway is listening (may be WS-only).
    _OCT_LAST_CHECK="ok"
  else
    _OCT_LAST_CHECK="fail"
  fi
  if [ "$do_assert" = "true" ]; then
    assert "Gateway is healthy (${OCT_GATEWAY_URL})" "$([ "$_OCT_LAST_CHECK" = "ok" ] && echo true || echo false)"
  fi
}

check_service() {
  local name="$1"
  local url="$2"
  local path="${3:-/health}"
  local do_assert="${4:-true}"
  _OCT_LAST_CHECK=$(curl -sf -o /dev/null --max-time 5 "${url}${path}" 2>/dev/null && echo "ok" || echo "fail")
  if [ "$do_assert" = "true" ]; then
    assert "$name is healthy (${url}${path})" "$([ "$_OCT_LAST_CHECK" = "ok" ] && echo true || echo false)"
  fi
}

check_browser() {
  local port="${1:-${OCT_BROWSER_PORT:-18791}}"
  _OCT_LAST_CHECK=$(curl -sf -o /dev/null --max-time 2 "http://localhost:${port}/json/version" 2>/dev/null && echo "ok" || echo "fail")
  if [ "$_OCT_LAST_CHECK" = "ok" ]; then
    assert "Browser is running (port $port)" "true"
  else
    warn "Browser not pre-started on port $port (may start on-demand)"
    _OCT_LAST_CHECK="on-demand"
  fi
}

wait_for_health() {
  local url="$1"
  local timeout_s="${2:-60}"
  local interval="${3:-1}"
  local elapsed=0
  local auth_args=()
  [ -n "${OCT_GATEWAY_TOKEN:-}" ] && auth_args=(-H "Authorization: Bearer ${OCT_GATEWAY_TOKEN}")
  while [ "$elapsed" -lt "$timeout_s" ]; do
    if curl -sf -o /dev/null "$url" --max-time 3 "${auth_args[@]}" 2>/dev/null; then
      return 0
    fi
    # Fallback: try root.
    local root="${url%/health}"
    if curl -sf -o /dev/null "${root}/" --max-time 3 "${auth_args[@]}" 2>/dev/null; then
      return 0
    fi
    if _oct_tcp_open "$url"; then
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  return 1
}

require_gateway() {
  check_gateway "true"
  if [ "$_OCT_LAST_CHECK" != "ok" ]; then
    echo -e "  ${RED}FATAL: Gateway not running at ${OCT_GATEWAY_URL}${NC}"
    echo -e "  ${RED}Start with: openclaw gateway restart${NC}"
    exit 1
  fi
}
