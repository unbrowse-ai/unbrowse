#!/usr/bin/env bash
# dev-restart.sh — kill ALL unbrowse/kuri processes and restart from source
# Usage: bash scripts/dev-restart.sh

set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[dev] killing all unbrowse/kuri processes..."
# Kill by port
for port in 6969 7700; do
  pids=$(lsof -ti :$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  port $port: killing $pids"
    kill $pids 2>/dev/null || true
  fi
done

# Kill orphaned bun server processes
pkill -f "bun src/server.ts" 2>/dev/null || true
pkill -f "kuri" 2>/dev/null || true

sleep 1

# Verify ports are free
for port in 6969 7700; do
  if lsof -ti :$port >/dev/null 2>&1; then
    echo "[dev] ERROR: port $port still in use after kill!"
    lsof -i :$port
    exit 1
  fi
done

echo "[dev] starting server from source: $DIR"
cd "$DIR"
bun src/server.ts &disown
sleep 3

# Health check
if unbrowse health >/dev/null 2>&1; then
  echo "[dev] server ready"
  unbrowse health
else
  echo "[dev] ERROR: server failed to start"
  exit 1
fi
