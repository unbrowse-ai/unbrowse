#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/submodules/openclaw-unbrowse-plugin"

if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
  bash "$ROOT_DIR/scripts/ensure-submodules.sh" submodules/openclaw-unbrowse-plugin
fi

exec bash "$PLUGIN_DIR/scripts/install-openclaw.sh" --plugin-path "$PLUGIN_DIR" "$@"
