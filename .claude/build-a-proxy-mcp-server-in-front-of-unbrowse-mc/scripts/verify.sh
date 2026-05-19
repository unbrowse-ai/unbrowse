#!/bin/bash
# verify.sh — hot-reload round-trip gate for the mcp-hot-proxy.
# Real-runtime: spawns scripts/mcp-hot-proxy.ts, talks JSON-RPC over stdio,
# edits src/mcp.ts to inject a sentinel, waits for the child swap, asserts
# the sentinel reaches the parent connection. No mocks.
set -uo pipefail
cd "$(dirname "$0")/../../.."
export PLAN=build-a-proxy-mcp-server-in-front-of-unbrowse-mc
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "[verify:$PLAN] gate: hot-reload round-trip (live JSON-RPC over the proxy)"
mkdir -p "$SCAFFOLD/logs"
LOG="$SCAFFOLD/logs/verify-$TS.log"

set +e
bun "$SCAFFOLD/scripts/verify-hot-reload.ts" 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
set -e

echo "[verify:$PLAN] rc=$RC log=$LOG"
exit "$RC"
