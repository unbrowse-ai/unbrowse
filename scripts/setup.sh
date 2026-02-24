#!/usr/bin/env bash
# One-shot setup: install deps, register, start server.
# Requires UNBROWSE_TOS_ACCEPTED=1 — the calling agent must ask the user first.
set -euo pipefail

SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/unbrowse}"
PORT="${PORT:-6969}"
HOST="${HOST:-127.0.0.1}"
UNBROWSE="http://${HOST}:${PORT}"

# Already running?
if curl -sf "$UNBROWSE/health" >/dev/null 2>&1; then
  echo "[unbrowse] Server already running on $UNBROWSE"
  exit 0
fi

# Require explicit ToS consent from user (via the agent)
if [ "${UNBROWSE_TOS_ACCEPTED:-}" != "1" ]; then
  echo "[unbrowse] ERROR: ToS not accepted."
  echo "[unbrowse] The agent must show the user the ToS and get consent before running this."
  echo "[unbrowse] Re-run with UNBROWSE_TOS_ACCEPTED=1 after user agrees."
  exit 1
fi

cd "$SKILL_DIR"

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "[unbrowse] Installing dependencies..."
  bun install --frozen-lockfile 2>/dev/null || bun install
fi

# Start in background — auto-registers on first run
echo "[unbrowse] Starting server on $UNBROWSE..."
UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 PORT="$PORT" HOST="$HOST" nohup bun src/index.ts > /tmp/unbrowse.log 2>&1 &
SERVER_PID=$!

# Wait for ready (up to 15s)
for i in $(seq 1 15); do
  if curl -sf "$UNBROWSE/health" >/dev/null 2>&1; then
    echo "[unbrowse] Ready (PID $SERVER_PID)"
    exit 0
  fi
  sleep 1
done

echo "[unbrowse] Failed to start. Check /tmp/unbrowse.log"
exit 1
