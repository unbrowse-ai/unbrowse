#!/bin/bash
# ship.sh - runs the declared ship_command for plan "add-an-opt-in-paid-residential-proxy-fallback-fo".
# Edit the state file's frontmatter (ship_command) to change behavior.
set -euo pipefail
# scripts/verify.sh -> ../../.. is the project root
cd "$(dirname "$0")/../../.."
PLAN=add-an-opt-in-paid-residential-proxy-fallback-fo
echo "[ship:$PLAN] surface: cloudflare (wrangler deploy / pages)"
echo "[ship:$PLAN] command:"
echo "  echo 'TODO: invoke the publishing skill for this artifact'; false"
echo 'TODO: invoke the publishing skill for this artifact'; false
