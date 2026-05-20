#!/usr/bin/env bash
# Ship for this harness = open / track the unbrowse-improvement-loop PR
# the current wave is shipping. The actual scoped commit is produced by
# /unbrowse-improvement-loop on a branch (NEVER main, never the public
# repo, never git add -A). This script surfaces the latest open PR
# created by the loop so the harness ledger can reference it; it does
# not stage or commit anything itself.
set -uo pipefail
cd "$(dirname "$0")/../../.."
PLAN=drive-every-bug-class-surfaced-by-the-mcp-gate-r
echo "[ship:$PLAN] surface: unbrowse-dev src/ via /unbrowse-improvement-loop PR (never main, never public repo)"
if command -v gh >/dev/null 2>&1; then
  gh pr list --repo unbrowse-ai/unbrowse-dev --state open --limit 5 \
    --json number,title,headRefName,createdAt \
    -q '.[]|select(.headRefName|test("^(fix|feat)/"))|"#\(.number) \(.headRefName) — \(.title)"' 2>/dev/null | head -5
fi
echo "[ship:$PLAN] EXPLICIT human step: review + merge the per-wave PR, then re-run /unbrowse-mcp-gate (or this harness's verify.sh) to measure delta."
exit 0
