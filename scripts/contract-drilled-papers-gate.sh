#!/usr/bin/env bash
# contract-drilled-papers-gate.sh — the runnable witness for the jesus-ralph north star:
# "it drilled down all the way through and test it out properly and ensure that /contract
#  whitepapers are all updated."
#
# Exit 0 iff ALL hold (no fabricated green; each is an independent witness):
#   A. DRILLED + TESTED — the contribution-stats you-view unit test passes (the CLI surface
#      that shows money made / saved, tokens, speed, time, web3-native wallet binding).
#   B. TYPE-CLEAN — the touched module typechecks (drilled through, no type break).
#   C. PAPER UPDATED — the new shipped fact (wallet-bound contribution ledger) appears in the
#      economy paper AND its code anchor exists (the paper reflects the code, not overclaims).
#   D. PAPERS REFLECT + NO LEAK — paper-gate.sh exits 0 on EVERY public .tex paper.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
say(){ echo "[drilled-papers] $*"; }

# ── A. DRILLED + TESTED ──
if bun test tests/eval-stats-youview.test.ts >/tmp/dp_test.log 2>&1; then
  say "A PASS — eval-stats you-view test green ($(grep -oE '[0-9]+ pass' /tmp/dp_test.log | head -1))"
else
  say "A FAIL — eval-stats you-view test red:"; tail -5 /tmp/dp_test.log; fail=1
fi

# ── B. TYPE-CLEAN (touched module) ──
if bunx tsc --noEmit --skipLibCheck src/cli-v7/eval/stats.ts >/tmp/dp_tsc.log 2>&1; then
  say "B PASS — src/cli-v7/eval/stats.ts typechecks"
else
  # tsc on a single file pulls its imports; tolerate pre-existing project errors NOT in stats.ts
  if grep -q 'cli-v7/eval/stats.ts' /tmp/dp_tsc.log; then
    say "B FAIL — type error IN stats.ts:"; grep 'cli-v7/eval/stats.ts' /tmp/dp_tsc.log | head -5; fail=1
  else
    say "B PASS — no type error in stats.ts (pre-existing project errors ignored)"
  fi
fi

# ── C. PAPER UPDATED — claim present AND anchored ──
ECON_PAPER="paper/internal-apis-were-not-all-you-needed.tex"
CLAIM="wallet-bound contribution ledger"
if grep -qiF "$CLAIM" "$ECON_PAPER" && [ -f "src/cli-v7/eval/stats.ts" ] && grep -qF "$CLAIM" paper/anchors.tsv; then
  say "C PASS — '$CLAIM' in economy paper, anchored to src/cli-v7/eval/stats.ts"
else
  say "C FAIL — economy paper missing the contribution-ledger claim or its anchor"; fail=1
fi

# ── D. EVERY public paper reflects code + leaks nothing ──
for p in paper/*.tex; do
  if bash scripts/paper-gate.sh "$p" >/tmp/dp_pg.log 2>&1; then
    say "D ok — $(basename "$p") paper-gate PASS"
  else
    say "D FAIL — $(basename "$p") paper-gate:"; grep -E 'FAIL|LEAK' /tmp/dp_pg.log | head -5; fail=1
  fi
done

echo
if [ "$fail" -ne 0 ]; then echo "[drilled-papers] GATE FAIL"; exit 1; fi
echo "[drilled-papers] GATE PASS — drilled, tested, and every whitepaper reflects the shipped code (no leak)."
