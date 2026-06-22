#!/usr/bin/env bash
# paper-unify-gate.sh — witness for "unify paper/". The corpus is UNIFIED when (1) a single
# index (paper/README.md) maps the whole corpus and references every paper, AND (2) the corpus
# is consistent + honest (the three shared paper gates pass). Not a merge — the trilogy stays
# separate by design; "unify" = one index + one coherent gated whole.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
idx="paper/README.md"
if [ -f "$idx" ]; then
  miss=""
  for p in crypto-was-all-you-needed internal-apis-are-all-you-need internal-apis-were-not-all-you-needed energy-route-ranking execute-dont-guess; do
    grep -q "$p" "$idx" || miss="$miss $p"
  done
  [ -z "$miss" ] && echo "  ok   unified index references all 5 papers" || { echo "  RED  index missing:$miss"; fail=1; }
else echo "  RED  no paper/README.md unified index"; fail=1; fi
for g in papers-done-gate papers-reflection-gate paper-gate; do
  bash "scripts/$g.sh" >/dev/null 2>&1 && echo "  ok   $g" || { echo "  RED  $g"; fail=1; }
done
echo
[ "$fail" -eq 0 ] && { echo "PAPER-UNIFY-GATE GREEN."; exit 0; } || { echo "PAPER-UNIFY-GATE RED."; exit 1; }
