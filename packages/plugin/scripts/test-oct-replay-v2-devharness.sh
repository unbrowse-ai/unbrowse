#!/usr/bin/env bash
set -euo pipefail

# Replay-v2 gateway E2E via OpenClaw Dev Harness (--dev) + /tools/invoke.
# Uses ~/.openclaw-dev workspace; links this plugin into dev; boots gateway on a free port; runs real-network suite pack.

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${PLUGIN_ROOT}/../.." && pwd)"

export OCT_LIB_DIR="${REPO_ROOT}/third_party/openclaw-test-suite/lib"
export PATH="${REPO_ROOT}/third_party/openclaw-test-suite/bin:${PATH}"

BASE_PORT="${OCT_GATEWAY_PORT_BASE:-19123}"
TOKEN="${OCT_GATEWAY_TOKEN:-}"
LOG_FILE="${OCT_GATEWAY_LOG:-/tmp/oct-replayv2-devharness-gateway.log}"

pick_port() {
  local start="$1"
  for p in $(seq "$start" $((start + 40))); do
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

detect_running_gateway() {
  # If a dev gateway is already running, reuse it (avoid lock contention).
  # Example commandline:
  #   openclaw --dev gateway --port 19001 --auth token --token test_token ...
  local line
  line="$(ps aux | rg -m1 "openclaw --dev gateway" || true)"
  if [ -z "$line" ]; then
    return 1
  fi

  local port token
  port="$(echo "$line" | rg -o -- "--port [0-9]+" | awk '{print $2}' | head -n1 || true)"
  token="$(echo "$line" | rg -o -- "--token [^ ]+" | awk '{print $2}' | head -n1 || true)"
  if [ -n "$port" ] && [ -n "$token" ]; then
    echo "${port} ${token}"
    return 0
  fi
  return 1
}

RUNNING="$(detect_running_gateway || true)"
if [ -n "$RUNNING" ]; then
  PORT="$(echo "$RUNNING" | awk '{print $1}')"
  TOKEN="$(echo "$RUNNING" | awk '{print $2}')"
else
  PORT="$(pick_port "$BASE_PORT")" || {
    echo "[oct] no free port found near ${BASE_PORT}"
    exit 1
  }
  if [ -z "$TOKEN" ]; then
    TOKEN="replayv2_devharness_token_$(date +%s)"
  fi
fi

export OCT_GATEWAY_URL="http://127.0.0.1:${PORT}"
export OCT_GATEWAY_TOKEN="$TOKEN"
export OCT_PLUGIN_ID="unbrowse-openclaw"
export OCT_PLUGIN_DIR="${PLUGIN_ROOT}"
export OCT_TOOL_TIMEOUT="${OCT_TOOL_TIMEOUT:-90}"

SUITE="${OCT_REPLAY_V2_SUITE:-suite-replay-v2-real-popular-stable.sh}"
echo "[oct] dev-harness url=${OCT_GATEWAY_URL} suite=${SUITE}"

# Ensure plugin is linked into dev harness state.
openclaw --dev plugins install --link "${PLUGIN_ROOT}" > /tmp/oct-replayv2-devharness-install.log 2>&1 || {
  if rg -q "Linked plugin path:" /tmp/oct-replayv2-devharness-install.log 2>/dev/null; then
    echo "[oct] plugin link returned non-zero but appears linked; continuing."
  else
    echo "[oct] plugin link failed. log tail:"
    tail -200 /tmp/oct-replayv2-devharness-install.log || true
    exit 1
  fi
}

GW_PID=""
if [ -z "$RUNNING" ]; then
  openclaw --dev gateway --allow-unconfigured --force --port "${PORT}" --auth token --token "${TOKEN}" >"${LOG_FILE}" 2>&1 &
  GW_PID=$!

  cleanup() {
    kill "${GW_PID}" 2>/dev/null || true
    wait "${GW_PID}" 2>/dev/null || true
  }
  trap cleanup EXIT
fi

# Wait for tool invocation to work.
for _ in {1..160}; do
  RESP="$(curl -sS -X POST "${OCT_GATEWAY_URL}/tools/invoke" \
    -H "Authorization: Bearer ${OCT_GATEWAY_TOKEN}" \
    -H "content-type: application/json" \
    --data '{"tool":"unbrowse_skills","args":{},"sessionKey":"oct-boot"}' \
    --max-time 2 2>/dev/null || true)"
  OK="$(printf '%s' "${RESP}" | jq -r '.ok // false' 2>/dev/null || echo false)"
  [ "$OK" = "true" ] && break
  sleep 0.25
done

OCT_VERBOSE="${OCT_VERBOSE:-1}" oct --run "${SUITE}" "${PLUGIN_ROOT}/test/oct"
