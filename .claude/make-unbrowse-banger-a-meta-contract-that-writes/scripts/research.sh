#!/bin/bash
# research.sh — surfaces the raw evidence a wave needs to write the next
# child contract. Evidence only, no verdict: it prints (1) unbrowse's own
# declared pain corpus, (2) installed skills whose domain overlaps
# "agent / browser / harness / bench", (3) the cited best-practice rows
# already distilled in references/banger-best-practices.md.
#
# The agent reads this, pairs a pain row with a best-practice row (running
# deepwiki / find-skills in-thread for any domain not yet cited), and calls
# generate-child.sh with the resulting scoped plan. This script never picks
# the pairing — that is the agent's in-thread judgement.
set -uo pipefail
PROJECT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"

echo "=============================================================="
echo " research.sh — raw evidence for the next 'make unbrowse banger' child"
echo "=============================================================="

echo
echo "## (1) unbrowse declared pain corpus — code:CLAUDE.md#Known Issues"
if [[ -f "$PROJECT/CLAUDE.md" ]]; then
  python3 - "$PROJECT/CLAUDE.md" <<'PYPAIN'
import sys
text = open(sys.argv[1]).read().splitlines()
grab = False
for ln in text:
    if ln.startswith("## Known Issues"):
        grab = True; continue
    if grab and ln.startswith("## "):
        break
    if grab and ln.strip():
        print("   " + ln)
PYPAIN
else
  echo "   (CLAUDE.md not found)"
fi

echo
echo "## (2) installed skills overlapping agent/browser/harness/bench"
ls "$HOME/.claude/skills" 2>/dev/null \
  | grep -iE 'unbrowse|harness|agent|browser|bench|eval|self-build|improvement' \
  | sed 's/^/   ~ /' || echo "   (no skills dir)"

echo
echo "## (3) cited best-practice rows already distilled"
if [[ -f "$SCAFFOLD/references/banger-best-practices.md" ]]; then
  grep -E '^### BP-|source_id:' "$SCAFFOLD/references/banger-best-practices.md" \
    | sed 's/^/   /'
else
  echo "   (references/banger-best-practices.md not found — run research first)"
fi

echo
echo "## (4) children already written by this umbrella"
if [[ -s "$SCAFFOLD/ledgers/children.txt" ]]; then
  sed 's/^/   - /' "$SCAFFOLD/ledgers/children.txt"
else
  echo "   (none yet)"
fi

echo
echo "--------------------------------------------------------------"
echo "NEXT: agent pairs an un-addressed pain row with a best-practice"
echo "row, runs deepwiki/find-skills in-thread for any new domain,"
echo "then: scripts/generate-child.sh \"<scoped child plan + source_id>\""
echo "--------------------------------------------------------------"
