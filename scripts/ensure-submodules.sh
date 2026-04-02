#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "[submodules] git not found"
  exit 1
fi

if [ ! -f .gitmodules ]; then
  echo "[submodules] no .gitmodules present; skipping"
  exit 0
fi

echo "[submodules] syncing"
git submodule sync --recursive

echo "[submodules] updating"
git submodule update --init --recursive "$@"

echo "[submodules] ready"
