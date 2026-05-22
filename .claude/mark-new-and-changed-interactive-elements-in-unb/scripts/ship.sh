#!/bin/bash
# ship.sh - runs the declared ship_command for plan "mark-new-and-changed-interactive-elements-in-unb".
# Edit the state file's frontmatter (ship_command) to change behavior.
set -euo pipefail
# scripts/verify.sh -> ../../.. is the project root
cd "$(dirname "$0")/../../.."
PLAN=mark-new-and-changed-interactive-elements-in-unb
echo "[ship:$PLAN] surface: cloudflare (wrangler deploy / pages)"
echo "[ship:$PLAN] command:"
echo "  git add -A && git commit -m 'fix: $(cat .claude/CURRENT_PLAN 2>/dev/null || echo iterate)'"
git add -A && git commit -m 'fix: $(cat .claude/CURRENT_PLAN 2>/dev/null || echo iterate)'
