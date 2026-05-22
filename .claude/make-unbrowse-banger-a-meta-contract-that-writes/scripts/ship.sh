#!/bin/bash
# ship.sh — persist ONLY the contract-writer artifacts: the umbrella
# scaffold + state file and every child contract it has generated
# (recorded in ledgers/children.txt). It never `git add -A` — that would
# sweep unrelated peer work and product code into the commit, breaking the
# no-regression commit gate (a commit claims the tree works).
#
# Refuses to commit on main/master (harness artifacts ride a feature
# branch, never land direct on the trunk).
set -euo pipefail
cd "$(dirname "$0")/../../.."
PLAN=make-unbrowse-banger-a-meta-contract-that-writes
SCAFFOLD=".claude/$PLAN"
MANIFEST="$SCAFFOLD/ledgers/children.txt"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" || "$BRANCH" == "unknown" ]]; then
  echo "[ship:$PLAN] on '$BRANCH' — refusing to commit harness artifacts to the trunk."
  echo "[ship:$PLAN] checkout a feature branch first; artifacts stay staged-free."
  exit 0
fi

echo "[ship:$PLAN] surface: umbrella + generated child contracts under .claude/"
echo "[ship:$PLAN] branch: $BRANCH"

# Stage the umbrella state file + scaffold, and the .gitignore re-include
# block generate-child.sh extends (without it the scaffold dirs stay ignored).
git add ".claude/$PLAN.local.md" "$SCAFFOLD" .gitignore 2>/dev/null || true

# Stage every child this umbrella generated (scaffold dir + state file).
if [[ -s "$MANIFEST" ]]; then
  while IFS= read -r child; do
    [[ -z "$child" ]] && continue
    git add ".claude/$child" ".claude/$child.local.md" 2>/dev/null || true
  done < "$MANIFEST"
fi

if git diff --cached --quiet; then
  echo "[ship:$PLAN] nothing staged — no change to persist this wave."
  exit 0
fi

N_CHILD=0
[[ -s "$MANIFEST" ]] && N_CHILD=$(grep -c . "$MANIFEST" || echo 0)
git commit -m "chore(harness): make-unbrowse-banger umbrella + ${N_CHILD} child contract(s)

Recursive contract-writer: each child is a scoped unbrowse improvement
derived from cited best-practice research (browser-use, claude-code).
See .claude/$PLAN/references/banger-best-practices.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
echo "[ship:$PLAN] committed $N_CHILD child contract(s) on $BRANCH"
