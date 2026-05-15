#!/usr/bin/env bash
# workbench-swap.sh
# Send SIGHUP to the running unbrowse-workbench proxy.ts process to toggle
# its live side (CANDIDATE vs BASELINE). Idempotent: SIGHUP just toggles each time.

set -euo pipefail

log() { printf '[workbench-swap] %s\n' "$*" >&2; }

PID_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pid)
      shift
      PID_OVERRIDE="${1:-}"
      [ -z "$PID_OVERRIDE" ] && { log "ERROR: --pid requires a value"; exit 64; }
      shift
      ;;
    --pid=*)
      PID_OVERRIDE="${1#--pid=}"
      shift
      ;;
    -h|--help)
      cat >&2 <<'EOF'
Usage: workbench-swap.sh [--pid N]
  Sends SIGHUP to the unbrowse-workbench proxy.ts process.
  With no --pid, discovers via pgrep -f 'unbrowse-workbench/bin/proxy.ts'.
EOF
      exit 0
      ;;
    *)
      log "ERROR: unknown arg: $1"
      exit 64
      ;;
  esac
done

if [ -n "$PID_OVERRIDE" ]; then
  PIDS="$PID_OVERRIDE"
else
  # Match the proxy.ts entry. -f matches against the full command line.
  # Use the workbench path fragment to avoid colliding with unrelated bun processes.
  PIDS="$(pgrep -f 'unbrowse-workbench/bin/proxy\.ts' || true)"
fi

# Drop our own pid + parent shell pid out of the result (defensive on macOS).
SELF_PID="$$"
PARENT_PID="${PPID:-0}"
FILTERED=""
for p in $PIDS; do
  if [ "$p" = "$SELF_PID" ] || [ "$p" = "$PARENT_PID" ]; then
    continue
  fi
  FILTERED="$FILTERED $p"
done
# Trim leading space.
FILTERED="${FILTERED# }"

if [ -z "$FILTERED" ]; then
  log "ERROR: no proxy.ts process found. Start it first:"
  log "  bun run /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/.claude/mcps/unbrowse-workbench/bin/proxy.ts"
  exit 1
fi

PID_COUNT="$(printf '%s\n' $FILTERED | wc -w | tr -d ' ')"
if [ "$PID_COUNT" -gt 1 ]; then
  log "ERROR: multiple proxy.ts processes found: $FILTERED"
  log "Pass --pid <N> to disambiguate."
  exit 2
fi

PID="$FILTERED"
log "sending SIGHUP to proxy pid $PID"
kill -HUP "$PID"
log "ok: pid=$PID toggled"
printf '%s\n' "$PID"
