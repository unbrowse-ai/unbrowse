#!/usr/bin/env bash
set -euo pipefail

# Replay-v2 gateway E2E (real OpenClaw + /tools/invoke).
# Starts an isolated OpenClaw profile + gateway, runs a real-network suite by default, then stops the gateway.

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${PLUGIN_ROOT}/../.." && pwd)"

export OCT_LIB_DIR="${REPO_ROOT}/third_party/openclaw-test-suite/lib"
export PATH="${REPO_ROOT}/third_party/openclaw-test-suite/bin:${PATH}"

PROFILE="${OCT_OPENCLAW_PROFILE:-replayv2}"
BASE_PORT="${OCT_GATEWAY_PORT_BASE:-19123}"
TOKEN="${OCT_GATEWAY_TOKEN:-replayv2_test_token_$(date +%s)}"
LOG_FILE="${OCT_GATEWAY_LOG:-/tmp/oct-replayv2-gateway-${PROFILE}.log}"

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

PORT="$(pick_port "$BASE_PORT")" || {
  echo "[oct] no free port found near ${BASE_PORT}"
  exit 1
}

export OCT_GATEWAY_URL="http://127.0.0.1:${PORT}"
export OCT_GATEWAY_TOKEN="$TOKEN"
export OCT_PLUGIN_ID="unbrowse-openclaw"
export OCT_PLUGIN_DIR="${PLUGIN_ROOT}"
export OCT_TOOL_TIMEOUT="${OCT_TOOL_TIMEOUT:-60}"

echo "[oct] profile=${PROFILE} port=${PORT} suite=suite-replay-v2.sh"

# Ensure plugin is linked into this profile.
openclaw --profile "${PROFILE}" plugins install --link "${PLUGIN_ROOT}" > /tmp/oct-replayv2-install.log 2>&1 || {
  if rg -q "Linked plugin path:" /tmp/oct-replayv2-install.log 2>/dev/null; then
    echo "[oct] plugin link returned non-zero but appears linked; continuing."
  else
    echo "[oct] plugin link failed. log tail:"
    tail -200 /tmp/oct-replayv2-install.log || true
    exit 1
  fi
}

# Start gateway (background) for this profile.
openclaw --profile "${PROFILE}" gateway --allow-unconfigured --force --port "${PORT}" --auth token --token "${TOKEN}" >"${LOG_FILE}" 2>&1 &
GW_PID=$!

cleanup() {
  kill "${GW_PID}" 2>/dev/null || true
  wait "${GW_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for tool invocation to work.
for _ in {1..120}; do
  RESP="$(curl -sS -X POST "${OCT_GATEWAY_URL}/tools/invoke" \
    -H "Authorization: Bearer ${OCT_GATEWAY_TOKEN}" \
    -H "content-type: application/json" \
    --data '{"tool":"unbrowse_skills","args":{},"sessionKey":"oct-boot"}' \
    --max-time 2 2>/dev/null || true)"
  OK="$(printf '%s' "${RESP}" | jq -r '.ok // false' 2>/dev/null || echo false)"
  [ "$OK" = "true" ] && break
  sleep 0.25
done

# Run suite (default: real network).
SUITE="${OCT_REPLAY_V2_SUITE:-suite-replay-v2-real.sh}"
OCT_VERBOSE="${OCT_VERBOSE:-1}" oct --run "${SUITE}" "${PLUGIN_ROOT}/test/oct"
