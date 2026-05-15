#!/usr/bin/env bash
# workbench-smoke.sh
# Round-trip smoke test:
#  1. Start the workbench proxy.ts under our control (stdin/stdout via FIFOs).
#  2. Send MCP initialize, assert _workbench_delta present in the response.
#  3. Call unbrowse_health, capture _workbench_delta.live.
#  4. SIGHUP via workbench-swap.sh.
#  5. Call unbrowse_health again, assert _workbench_delta.live FLIPPED.
#  6. Tear down.
# Exit 0 only if both calls round-tripped AND live flipped.

set -euo pipefail

REPO_ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
WORKBENCH_DIR="$REPO_ROOT/.claude/mcps/unbrowse-workbench"
PROXY_ENTRY="$WORKBENCH_DIR/bin/proxy.ts"
SWAP_SCRIPT="$WORKBENCH_DIR/scripts/workbench-swap.sh"

log() { printf '[smoke] %s\n' "$*" >&2; }
err() { printf '[smoke][ERROR] %s\n' "$*" >&2; }

if [ ! -f "$PROXY_ENTRY" ]; then
  err "proxy entry not found: $PROXY_ENTRY"
  err "Worker A has not landed bin/proxy.ts yet. Day 3 status: forgiving."
  exit 10
fi

# Prefer jq when available, fall back to grep+sed.
HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAVE_JQ=1
fi

WORKDIR="$(mktemp -d -t workbench-smoke.XXXXXXXX)"
IN_FIFO="$WORKDIR/proxy.in"
OUT_FILE="$WORKDIR/proxy.out"
ERR_FILE="$WORKDIR/proxy.err"
mkfifo "$IN_FIFO"

PROXY_PID=""
cleanup() {
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill -TERM "$PROXY_PID" 2>/dev/null || true
    sleep 0.3
    kill -KILL "$PROXY_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

log "starting proxy: bun run $PROXY_ENTRY"
# Keep the FIFO open by attaching a long-lived background sleep as a writer,
# otherwise EOF closes proxy stdin as soon as the first message is delivered.
# Use FD 3 in this shell to hold the write end open.
exec 3>"$IN_FIFO"

bun run "$PROXY_ENTRY" <"$IN_FIFO" >"$OUT_FILE" 2>"$ERR_FILE" &
PROXY_PID=$!
log "proxy pid=$PROXY_PID"

# Wait briefly for proxy to be ready.
sleep 0.8
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  err "proxy died during startup. stderr:"
  sed 's/^/[proxy.err] /' "$ERR_FILE" >&2 || true
  exit 11
fi

send_request() {
  local payload="$1"
  printf '%s\n' "$payload" >&3
}

# Read the next JSON line from $OUT_FILE that we have not yet consumed.
# We track a byte offset cursor so we always pick up the next response.
CURSOR=0
wait_for_line() {
  local timeout_ms="${1:-5000}"
  local elapsed=0
  local step=100
  while [ "$elapsed" -lt "$timeout_ms" ]; do
    local size
    size="$(wc -c <"$OUT_FILE" 2>/dev/null | tr -d ' ')"
    if [ "$size" -gt "$CURSOR" ]; then
      # Extract bytes since cursor; pick the first newline-terminated record.
      local chunk
      chunk="$(dd if="$OUT_FILE" bs=1 skip="$CURSOR" count=$((size - CURSOR)) 2>/dev/null || true)"
      local line
      line="$(printf '%s' "$chunk" | head -n 1)"
      if [ -n "$line" ]; then
        # Advance cursor past this line + its newline.
        local linelen=$((${#line} + 1))
        CURSOR=$((CURSOR + linelen))
        printf '%s\n' "$line"
        return 0
      fi
    fi
    sleep 0.1
    elapsed=$((elapsed + step))
  done
  return 1
}

extract_workbench_live() {
  local resp="$1"
  if [ "$HAVE_JQ" = "1" ]; then
    printf '%s' "$resp" | jq -r '.. | ._workbench_delta? // empty | .live? // empty' | head -n 1
  else
    # Best effort: pick "live":"<value>" from the payload.
    printf '%s' "$resp" | grep -o '"live"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 \
      | sed -E 's/.*"live"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
  fi
}

# Step 1: initialize.
log "sending initialize"
send_request '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"workbench-smoke","version":"0.0.1"}}}'
INIT_RESP="$(wait_for_line 7000 || true)"
if [ -z "$INIT_RESP" ]; then
  err "no initialize response within timeout"
  err "proxy stderr:"
  sed 's/^/[proxy.err] /' "$ERR_FILE" >&2 || true
  exit 12
fi
if ! printf '%s' "$INIT_RESP" | grep -q '_workbench_delta'; then
  err "initialize response missing _workbench_delta. payload:"
  printf '%s\n' "$INIT_RESP" >&2
  exit 13
fi
log "initialize ok: _workbench_delta present"

# Step 2: first unbrowse_health.
log "calling unbrowse_health (pre-swap)"
send_request '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"unbrowse_health","arguments":{}}}'
HEALTH1="$(wait_for_line 10000 || true)"
if [ -z "$HEALTH1" ]; then
  err "no unbrowse_health response (pre-swap)"
  exit 14
fi
LIVE1="$(extract_workbench_live "$HEALTH1")"
log "pre-swap live=${LIVE1:-<empty>}"
if [ -z "$LIVE1" ]; then
  err "_workbench_delta.live missing in pre-swap health response:"
  printf '%s\n' "$HEALTH1" >&2
  exit 15
fi

# Step 3: SIGHUP via workbench-swap.sh.
log "triggering swap via workbench-swap.sh --pid $PROXY_PID"
if ! bash "$SWAP_SCRIPT" --pid "$PROXY_PID" >&2; then
  err "workbench-swap.sh failed"
  exit 16
fi
sleep 0.4

# Step 4: second unbrowse_health.
log "calling unbrowse_health (post-swap)"
send_request '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"unbrowse_health","arguments":{}}}'
HEALTH2="$(wait_for_line 10000 || true)"
if [ -z "$HEALTH2" ]; then
  err "no unbrowse_health response (post-swap)"
  exit 17
fi
LIVE2="$(extract_workbench_live "$HEALTH2")"
log "post-swap live=${LIVE2:-<empty>}"
if [ -z "$LIVE2" ]; then
  err "_workbench_delta.live missing in post-swap health response:"
  printf '%s\n' "$HEALTH2" >&2
  exit 18
fi

if [ "$LIVE1" = "$LIVE2" ]; then
  err "swap did not flip live side: pre=$LIVE1 post=$LIVE2"
  err "pre payload:"
  printf '%s\n' "$HEALTH1" >&2
  err "post payload:"
  printf '%s\n' "$HEALTH2" >&2
  exit 19
fi

log "SUCCESS: live flipped $LIVE1 -> $LIVE2"
exit 0
