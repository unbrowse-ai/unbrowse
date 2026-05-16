#!/usr/bin/env bash
# Step 5 Slice 4 (S4): does the MCP stdio child die when the daemon is killed mid-call?
set -u

PID_FILE="$HOME/.unbrowse/run/server-localhost-6969.json"
ART_DIR="$(pwd)/.daemon-death"
rm -rf "$ART_DIR" && mkdir -p "$ART_DIR"
FIFO="$ART_DIR/in.fifo"
OUT="$ART_DIR/out.log"
ERR="$ART_DIR/err.log"
SUMMARY="$ART_DIR/summary.txt"
mkfifo "$FIFO"

echo "[setup] pkill any existing unbrowse/kuri" | tee -a "$SUMMARY"
pkill -9 -f "unbrowse|kuri" 2>/dev/null || true
sleep 2

# Open FIFO read+write to avoid the writer-blocks-until-reader deadlock.
exec 3<>"$FIFO"

echo "[spawn] unbrowse mcp" | tee -a "$SUMMARY"
unbrowse mcp <"$FIFO" >"$OUT" 2>"$ERR" &
MCP_PID=$!
echo "[spawn] MCP_PID=$MCP_PID" | tee -a "$SUMMARY"

send() { printf "%s\n" "$1" >&3; }

send "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"daemon-death\",\"version\":\"0\"}}}"
sleep 1
send "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}"
sleep 4

DAEMON_PID=""
if [ -f "$PID_FILE" ]; then
  DAEMON_PID="$(grep -o "\"pid\":[ ]*[0-9]*" "$PID_FILE" | grep -o "[0-9]*" | head -1)"
fi
echo "[daemon] pid=$DAEMON_PID" | tee -a "$SUMMARY"

echo "[call] sending tools/call unbrowse_run carousell" | tee -a "$SUMMARY"
send "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"unbrowse_run\",\"arguments\":{\"url\":\"https://www.carousell.sg/search/shoes\",\"intent\":\"list shoes\"}}}"

sleep 3
if [ -n "${DAEMON_PID:-}" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "[kill] SIGKILL daemon pid=$DAEMON_PID" | tee -a "$SUMMARY"
  kill -9 "$DAEMON_PID" 2>/dev/null || true
else
  echo "[kill] daemon already gone before kill point" | tee -a "$SUMMARY"
fi

sleep 5
if kill -0 "$MCP_PID" 2>/dev/null; then
  CHILD_STATE="alive"
else
  CHILD_STATE="dead"
fi
echo "[observe-5s] MCP child state: $CHILD_STATE" | tee -a "$SUMMARY"

RESPAWN_RESULT="not_tested"
if [ "$CHILD_STATE" = "alive" ]; then
  echo "[respawn-test] sending follow-up tools/list" | tee -a "$SUMMARY"
  send "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/list\",\"params\":{}}"
  sleep 5
  NEW_PID=""
  if [ -f "$PID_FILE" ]; then
    NEW_PID="$(grep -o "\"pid\":[ ]*[0-9]*" "$PID_FILE" | grep -o "[0-9]*" | head -1)"
  fi
  if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$DAEMON_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; then
    RESPAWN_RESULT="respawned_pid_$NEW_PID"
  elif grep -q "\"id\":4" "$OUT" 2>/dev/null; then
    RESPAWN_RESULT="responded_id4_pid_unclear_new=${NEW_PID:-none}"
  else
    RESPAWN_RESULT="no_response_after_5s_new_pid=${NEW_PID:-none}"
  fi
  echo "[respawn-test] $RESPAWN_RESULT" | tee -a "$SUMMARY"
fi

if kill -0 "$MCP_PID" 2>/dev/null; then
  VERDICT="child_survived"
  kill -TERM "$MCP_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$MCP_PID" 2>/dev/null || true
else
  wait "$MCP_PID" 2>/dev/null
  RC=$?
  if [ "$RC" -gt 128 ]; then
    SIG=$((RC - 128))
    VERDICT="child_died_signal_$SIG"
  else
    VERDICT="child_died_code_$RC"
  fi
fi

exec 3>&-

{
  echo ""
  echo "=== RESULT ==="
  echo "VERDICT=$VERDICT"
  echo "RESPAWN_RESULT=$RESPAWN_RESULT"
  echo "MCP_PID=$MCP_PID"
  echo "DAEMON_PID=${DAEMON_PID:-unknown}"
  echo "out_log=$OUT"
  echo "err_log=$ERR"
  echo "out_log_size=$(wc -c <"$OUT" | tr -d " ")"
  echo "err_log_size=$(wc -c <"$ERR" | tr -d " ")"
} | tee -a "$SUMMARY"
