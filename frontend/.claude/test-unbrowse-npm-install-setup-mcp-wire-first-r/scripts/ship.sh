#!/bin/bash
# ship.sh - runs the declared ship_command for plan "test-unbrowse-npm-install-setup-mcp-wire-first-r".
# Edit the state file's frontmatter (ship_command) to change behavior.
set -euo pipefail
# scripts/verify.sh -> ../../.. is the project root
cd "$(dirname "$0")/../../.."
PLAN=test-unbrowse-npm-install-setup-mcp-wire-first-r
echo "[ship:$PLAN] surface: git commit + corpus-gate stamp"
echo "[ship:$PLAN] command:"
echo "  git add -A && git diff --cached --quiet || git commit -m 'iterate: $(date +%s)'"
git add -A && git diff --cached --quiet || git commit -m 'iterate: $(date +%s)'
