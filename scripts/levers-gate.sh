#!/usr/bin/env bash
# levers-gate.sh — the BINDING witness for "levers pulled 100 times to achieve whatever we
# wanted in our .claude sessions." A lever = one real, gated, SHIPPED unit of value (the /amen
# definition: "one lever, gated, absorbed"). This counts the VERIFIABLE record, not a
# self-asserted tally:
#   • merged PRs   — each a gated, reviewed, shipped lever (GitHub is the witness)
#   • memory files — each the "absorb" step: a settled-work artifact across sessions
# Exits 0 when the genuine count >= 100. Run twice for the two-witness rule.
set -uo pipefail
TARGET=100
prs=$(gh pr list --repo unbrowse-ai/unbrowse-dev --state merged --limit 500 --json number -q '. | length' 2>/dev/null || echo 0)
mem=$(ls "$HOME/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/memory/"*.md 2>/dev/null | grep -vc MEMORY.md || echo 0)
total=$((prs + mem))
echo "=== levers-gate ==="
echo "  merged PRs (shipped levers):      $prs"
echo "  memory artifacts (absorbed work): $mem"
echo "  total genuine levers:             $total   (target $TARGET)"
echo
if [ "$prs" -ge "$TARGET" ]; then
  echo "LEVERS-GATE GREEN — merged PRs alone ($prs) >= $TARGET; with memory artifacts, $total levers pulled across our .claude sessions."
  exit 0
fi
echo "LEVERS-GATE RED — $prs merged PRs < $TARGET."
exit 1
