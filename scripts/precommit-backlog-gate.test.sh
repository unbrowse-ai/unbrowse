#!/usr/bin/env bash
# precommit-backlog-gate.test.sh — falsifiable SIGN over the standing no-fake-green pre-commit gate.
# Proves precommit.sh BLOCKS a commit that stages a fabricated 'shipped' backlog row, and that the
# wiring cannot be silently removed. Exits 0 exactly when the standing gate holds. Mutation-proven.
# Scoped to the backlog doc only (git restore --staged/checkout that one path), safe with other staged
# files. A trap restores on ANY exit so it leaves no leaven.
set -uo pipefail
ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
DOC="docs/UNBROWSE-CAPABILITY-BACKLOG.md"
cd "$ROOT"
fail=0
restore() { git restore --staged "$DOC" >/dev/null 2>&1 || true; git checkout -- "$DOC" >/dev/null 2>&1 || true; }
trap restore EXIT

echo "── 1. WIRING present: precommit.sh runs capability-backlog-gate.sh (catches silent removal) ──"
if grep -q 'capability-backlog-gate.sh' scripts/precommit.sh && grep -q 'capability-backlog fake-green' scripts/precommit.sh; then
  echo "  ok   backlog gate wired into precommit"
else
  echo "  FAIL backlog gate NOT wired into precommit (removed?)"; fail=1
fi

echo "── 2. BEHAVIOR: staged fabricated 'shipped' row → precommit BLOCKS (exit 1 + fake-green) ──"
printf '\n| 90 | sign-probe | x | both | shipped | `NO-SUCH-sign.zig` | 1 | P0 | sign |\n' >> "$DOC"
git add "$DOC" >/dev/null 2>&1
out="$(bash scripts/precommit.sh 2>&1)"; rc=$?
restore
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'capability-backlog fake-green'; then
  echo "  ok   fabricated row → commit blocked (exit $rc)"
else
  echo "  FAIL fabricated row did NOT block the commit (rc=$rc)"; fail=1
fi

echo "── 3. STAGED-EVASION (Day-5 sheep): fake row STAGED but working tree reverted → still BLOCKS ──"
# the precommit gate must validate STAGED content, not the working tree, or a staged fake row reverted
# in the working tree slips past into the commit.
clean="$(mktemp)"; cp "$DOC" "$clean"
printf '\n| 88 | sign-evasion | x | both | shipped | `NO-SUCH-evade.zig` | 1 | P0 | sign |\n' >> "$DOC"
git add "$DOC" >/dev/null 2>&1; cp "$clean" "$DOC"   # staged=fake, working=clean
out="$(bash scripts/precommit.sh 2>&1)"; rc=$?
git restore --staged "$DOC" >/dev/null 2>&1; cp "$clean" "$DOC"; rm -f "$clean"
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'capability-backlog fake-green'; then
  echo "  ok   staged fake row (working reverted) → still blocked"
else
  echo "  FAIL staged-evasion slipped past (rc=$rc) — gate read working tree, not staged"; fail=1
fi

[ "$fail" -eq 0 ] && { echo "── PRECOMMIT-BACKLOG-SIGN GREEN — the standing no-fake-green gate holds ──"; exit 0; }
echo "── PRECOMMIT-BACKLOG-SIGN RED ──"; exit 1
