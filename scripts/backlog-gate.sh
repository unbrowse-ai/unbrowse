#!/usr/bin/env bash
# backlog-gate.sh — the master witness for "rank everything unfinished, plan it,
# then do it all". Parses .claude/backlog.tsv and:
#   1. asserts the plan artifacts exist (UNBROWSE-BACKLOG.md + backlog.tsv),
#   2. INTEGRITY: every row marked `done` must have a witness that exits 0
#      (no fake-done — you cannot mark a thing done without it actually passing),
#   3. COMPLETION: every AUTONOMOUS row (not human-gated, not unbounded) must be
#      `done`. Human-gated and unbounded rows are PARKED with rationale, never
#      counted — folding them in would make this gate eternal/fake.
#
# Exit 0 only when the plan exists, nothing is fake-done, and every autonomous
# item is genuinely done. Until then it points at the next unsettled node.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
TSV=.claude/backlog.tsv
MD=.claude/UNBROWSE-BACKLOG.md

fail=0
pass(){ printf '\033[32m  ok\033[0m %s\n' "$1"; }
bad(){ printf '\033[31mMISS\033[0m %s\n' "$1"; fail=1; }
park(){ printf '\033[33mPARK\033[0m %s\n' "$1"; }

[ -f "$TSV" ] || { echo "FATAL: $TSV missing"; exit 1; }
[ -f "$MD" ] && pass "plan: $MD present" || bad "plan: $MD missing"

# Outward items transitively blocked on the single HUMAN blocker (paper2 sign-off).
HUMAN_BLOCKED_OUTWARD="push-public history-scrub release-announce npm-deprecate"
# Items parked on a PRODUCT decision (not a build): e.g. exa-search-backend —
# /v1/search is free by design (PR #816); pricing it + splitting per-search would
# reverse a deliberate decision, so it needs the user's call, not an autonomous build.
PRODUCT_PARKED="account-gate meta-mcp-hotswap"

todo=0 done=0 parked=0 integrity=0
while IFS=$'\t' read -r id class wave leverage deps status witness title; do
  [ "$id" = "id" ] && continue            # header
  [ -z "$id" ] && continue
  parked_row=0
  case "$class" in HUMAN|UNBOUNDED) parked_row=1;; esac
  case " $HUMAN_BLOCKED_OUTWARD " in *" $id "*) parked_row=1;; esac
  case " $PRODUCT_PARKED " in *" $id "*) parked_row=1;; esac

  if [ "$status" = "done" ]; then
    if bash -c "$witness" >/dev/null 2>&1; then
      pass "[$id] done + witness green"
      done=$((done+1))
    else
      bad "[$id] marked done but witness FAILS: $witness"
      integrity=$((integrity+1))
    fi
  elif [ "$parked_row" = "1" ]; then
    park "[$id] ($class) — parked: $title"
    parked=$((parked+1))
  else
    bad "[$id] TODO (wave $wave, $leverage) — $title"
    todo=$((todo+1))
  fi
done < "$TSV"

echo
echo "done=$done  todo=$todo  parked=$parked  integrity-violations=$integrity"
if [ "$fail" -eq 0 ] && [ "$integrity" -eq 0 ]; then
  echo "GREEN — plan complete; every autonomous backlog item is done (parked = human/unbounded only)."
  exit 0
else
  echo "RED — backlog not yet fully settled (or a fake-done was caught)."
  exit 1
fi
