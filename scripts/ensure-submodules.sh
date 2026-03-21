#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KURI_DIR="$ROOT_DIR/submodules/kuri"
OPENCLAW_DIR="$ROOT_DIR/integrations/openclaw"

cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[submodules] ERROR: not inside a git worktree"
  exit 1
fi

echo "[submodules] syncing tracked submodules"
git submodule sync -- submodules/kuri
git submodule update --init --recursive submodules/kuri

if [ ! -f "$KURI_DIR/build.zig" ]; then
  echo "[submodules] ERROR: missing Kuri checkout at $KURI_DIR"
  echo "[submodules] Run: git submodule update --init --recursive"
  exit 1
fi

if [ -f "$OPENCLAW_DIR/package.json" ] && [ ! -d "$OPENCLAW_DIR/node_modules" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "[submodules] ERROR: npm is required to install OpenClaw integration dependencies"
    exit 1
  fi

  echo "[submodules] installing OpenClaw integration dependencies"
  npm ci --prefix "$OPENCLAW_DIR"
fi

echo "[submodules] ready"
