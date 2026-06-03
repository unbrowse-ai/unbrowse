#!/usr/bin/env bash
# whitepaper-signoff-gate.sh — the named blocker: Paper 2 finished AND signed off.
#
# sp-opencore release loop: build-open -> scan-for-leaks -> JUDGE -> ship. This gate
# is the JUDGE before the public ship of Paper 2. It exits 0 only when:
#   1. FINISHED — the whitepaper is done as code (papers-done-gate green) and the
#      public paper is leak-clean.
#   2. SIGNED-OFF — paper/SIGNOFF.md carries a real sign-off line from Kevin or
#      Rach Pradhan with a date.
#
# Part 1 is the machine's to settle (green). Part 2 is a person's — only Kevin or
# Rach can turn this gate green, by adding their SIGNED-OFF line and committing it.
# No string fakes it; the loop honestly waits on the human.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SIGNOFF="paper/SIGNOFF.md"
fail=0
section() { echo; echo "=== $1 ==="; }

section "1. whitepaper FINISHED (done as code + leak-clean)"
if bash scripts/papers-done-gate.sh >/tmp/wsg_papers.out 2>&1; then echo "  papers-done-gate: green"; else echo "  FINISHED-FAIL: papers-done-gate not green (see /tmp/wsg_papers.out)"; fail=1; fi
if bash scripts/leak-guard.sh paper/crypto-was-all-you-needed.tex >/dev/null 2>&1; then echo "  leak-guard: Paper 2 clean"; else echo "  FINISHED-FAIL: Paper 2 leak-guard"; fail=1; fi

section "2. SIGNED-OFF by Kevin or Rach Pradhan"
sig=$(grep -nE '^SIGNED-OFF:[[:space:]]*(Kevin|Rach Pradhan|Rach)\b.*[0-9]{4}-[0-9]{2}-[0-9]{2}' "$SIGNOFF" 2>/dev/null | head -1 || true)
if [ -n "$sig" ]; then
  echo "  signed: $sig"
else
  echo "  SIGNOFF-PENDING: $SIGNOFF has no 'SIGNED-OFF: <Kevin|Rach Pradhan> <date>' line"
  echo "                   -> the blocker is a human sign-off; the loop waits on Kevin or Rach."
  fail=1
fi

echo
if [ "$fail" -ne 0 ]; then echo "WHITEPAPER-SIGNOFF-GATE FAIL — Paper 2 is not yet finished+signed; public rollout stage 2 stays blocked."; exit 1; fi
echo "WHITEPAPER-SIGNOFF-GATE PASS — Paper 2 finished and signed off; stage 2 of the rollout may trigger."
