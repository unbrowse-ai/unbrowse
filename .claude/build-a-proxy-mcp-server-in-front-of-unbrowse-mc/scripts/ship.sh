#!/bin/bash
# ship.sh - runs the declared ship_command for plan "build-a-proxy-mcp-server-in-front-of-unbrowse-mc".
# Edit the state file's frontmatter (ship_command) to change behavior.
set -euo pipefail
# scripts/verify.sh -> ../../.. is the project root
cd "$(dirname "$0")/../../.."
PLAN=build-a-proxy-mcp-server-in-front-of-unbrowse-mc
echo "[ship:$PLAN] surface: cloudflare (wrangler deploy / pages)"
echo "[ship:$PLAN] command:"
echo "  git add -A && git diff --cached --quiet || git commit -m 'iterate: $(date +%s)'"
git add -A && git diff --cached --quiet || git commit -m 'iterate: $(date +%s)'
