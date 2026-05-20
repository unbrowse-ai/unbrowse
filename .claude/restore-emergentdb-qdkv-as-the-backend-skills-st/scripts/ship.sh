#!/bin/bash
# ship.sh - runs the declared ship_command for plan "restore-emergentdb-qdkv-as-the-backend-skills-st".
# Edit the state file's frontmatter (ship_command) to change behavior.
set -euo pipefail
# scripts/verify.sh -> ../../.. is the project root
cd "$(dirname "$0")/../../.."
PLAN=restore-emergentdb-qdkv-as-the-backend-skills-st
echo "[ship:$PLAN] surface: cloudflare (wrangler deploy / pages)"
echo "[ship:$PLAN] command:"
echo "  git add -A && git diff --cached --quiet || git commit -m 'iterate: $(date +%s)'"
git add -A && git diff --cached --quiet || git commit -m 'iterate: $(date +%s)'
