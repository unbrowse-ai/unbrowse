#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

mkdir -p "$HERMES_HOME/plugins"
mkdir -p "$HERMES_HOME/skills/marketing/unbrowse-growth-os"

rm -rf "$HERMES_HOME/plugins/unbrowse"
cp -R "$ROOT/dropin/unbrowse" "$HERMES_HOME/plugins/unbrowse"
cp "$ROOT/skills/unbrowse-growth-os/SKILL.md" "$HERMES_HOME/skills/marketing/unbrowse-growth-os/SKILL.md"

echo "Installed Hermes plugin: $HERMES_HOME/plugins/unbrowse"
echo "Installed Hermes skill:  $HERMES_HOME/skills/marketing/unbrowse-growth-os/SKILL.md"
echo
echo "Smoke test:"
echo "  hermes chat -Q -s unbrowse-growth-os -q 'Use the unbrowse tool with action health. Reply with only the resulting status.'"
