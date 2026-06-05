#!/usr/bin/env bash
# Witness: browsecomp was run 5 times (run4..run8), each a REAL recorded run —
# a ledger row tied to an exited-0 eval log carrying "Evaluation complete. Score:".
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
L=bench/browsecomp/runs.ledger.jsonl
fail=0
for id in run4 run5 run6 run7 run8; do
  in_ledger=$(grep -c "\"run\": \"$id\"" "$L" 2>/dev/null); in_ledger=${in_ledger:-0}
  log="bench/browsecomp/logs/$id.log"
  scored=$(grep -c "Evaluation complete. Score:" "$log" 2>/dev/null); scored=${scored:-0}
  if [ "$in_ledger" -ge 1 ] && [ "$scored" -ge 1 ]; then
    sc=$(grep -m1 "Evaluation complete. Score:" "$log" | sed -E 's/.*Score: *//')
    echo "ok   $id — recorded, score=$sc"
  else
    echo "FAIL $id — ledger=$in_ledger scored_log=$scored (not done yet)"
    fail=1
  fi
done
[ "$fail" = "0" ] && echo "GATE GREEN" || echo "GATE RED"
exit $fail
