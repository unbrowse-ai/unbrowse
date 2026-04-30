#!/usr/bin/env bash
# Manual probe: stale kuri process / port reclaim behavior.
#
# Goal: when a kuri broker is killed -9, can a fresh kuri immediately bind
# the same port? This is the "works from source, broken from package" case
# CLAUDE.md flags as the #1 stale-process pitfall.
#
# This probe avoids any visible Chrome by setting HEADLESS=true. Kuri will
# still spawn a managed Chrome (it has no broker-only mode), but headless.
# Cleanup is done at start AND end.

set -u

KURI_BIN="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/packages/skill/vendor/kuri/darwin-arm64/kuri"
PORT="${PROBE_PORT:-8765}"
LOG1="/tmp/stale-kuri-probe-1.log"
LOG2="/tmp/stale-kuri-probe-2.log"

cleanup() {
  pkill -9 -f 'kuri|chrome' 2>/dev/null || true
  sleep 1
}

cleanup
echo "=== probe start (port=$PORT) ==="

echo "[run1] spawning kuri"
HEADLESS=true PORT="$PORT" HOST=127.0.0.1 "$KURI_BIN" >"$LOG1" 2>&1 &
PID1=$!
echo "[run1] pid=$PID1"

for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "[run1] healthy after ${i}x200ms"
    break
  fi
  sleep 0.2
done

echo "[run1] kill -9 $PID1"
kill -9 "$PID1" 2>/dev/null || true
wait "$PID1" 2>/dev/null || true

pkill -9 -f 'chrome' 2>/dev/null || true
sleep 1

echo "[port] lsof on $PORT after kill:"
lsof -iTCP:"$PORT" -sTCP:LISTEN 2>&1 || echo "(no listener)"
echo "[port] netstat anything on $PORT:"
netstat -an -p tcp 2>/dev/null | grep "\.$PORT " || echo "(no entries)"

echo "[run2] spawning kuri on same port"
HEADLESS=true PORT="$PORT" HOST=127.0.0.1 "$KURI_BIN" >"$LOG2" 2>&1 &
PID2=$!
echo "[run2] pid=$PID2"

OK=0
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "[run2] healthy after ${i}x200ms"
    OK=1
    break
  fi
  sleep 0.2
done

if [ "$OK" -eq 0 ]; then
  echo "[run2] FAILED to bind/become healthy on port $PORT within 10s"
  echo "[run2] last log lines:"
  tail -20 "$LOG2" || true
fi

cleanup
echo "=== probe end (rc=$([ "$OK" -eq 1 ] && echo PASS || echo FAIL)) ==="
exit $([ "$OK" -eq 1 ] && echo 0 || echo 1)
