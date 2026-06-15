#!/usr/bin/env bash
# gate_correctness.sh — Axis E: the VALUE-CORRECTNESS witness gate_all.sh was missing.
#
# gate_all.sh proves reproducibility (two witnesses agree, content-bound, auth, no-leak); a
# consistently-WRONG answer passes it. This gate proves the published CLI returns values that
# match known immutable GROUND TRUTH, two-witness (correct AND reproducible), AND that the
# hole-dereference invariant holds (resolved secrets never on the observable surface — witnessed
# by Axis D leak_clean, the same hashes-only property from execute.ts:24-30).
#
# Exit 0 iff:  accuracy >= MIN_ACCURACY over >= MIN_SCORED actually-fetched rows (two-witness)
#         AND  a D_security leak_clean=true row exists (hashes-only / hole-deref witness).
# A rate-limited run where too few rows fetch is BLOCKED → exit 1 (never a fabricated green).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HIST="$HERE/history.jsonl"
MIN_ACCURACY="${MIN_ACCURACY:-0.85}"
MIN_SCORED="${MIN_SCORED:-6}"
TS="$(date -u +%Y-%m-%dT%H%M%SZ)"

echo "── gate_correctness: value-correctness scorer (Axis E) ──"
OUT="$(python3 "$HERE/value_correctness.py" 2>/dev/null)" || { echo "  FAIL scorer crashed"; exit 1; }

read -r ACC SCORED NPASS NWRONG NBLOCKED CLI <<<"$(printf '%s' "$OUT" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(d["accuracy"], d["scored"], d["pass"], d["wrong"], d["blocked"], (d.get("cli") or "?").replace(" ","_"))
')"

echo "  cli=$CLI accuracy=$ACC pass=$NPASS/$SCORED scored wrong=$NWRONG blocked=$NBLOCKED"

# Append the honest E_correctness evidence row.
printf '%s\n' "$OUT" | python3 -c '
import sys,json,time
d=json.load(sys.stdin)
row={"source":"live","axis":"E_correctness","ts":"'"$TS"'","cli":d.get("cli"),
     "two_witness":True,"n":d["n"],"scored":d["scored"],"pass":d["pass"],
     "wrong":d["wrong"],"blocked":d["blocked"],"accuracy":d["accuracy"],
     "hosts":d.get("hosts"),"wrong_ids":[r["id"] for r in d["rows"] if r["verdict"]=="WRONG"],
     "gate":"true" if (d["scored"]>='"$MIN_SCORED"' and d["accuracy"]>='"$MIN_ACCURACY"') else "false"}
open("'"$HIST"'","a").write(json.dumps(row)+"\n")
'

# The hole-deref / hashes-only witness: an existing D_security leak_clean row.
LEAK_CLEAN="$(python3 - "$HIST" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print("yes" if any(r.get("axis")=="D_security" and r.get("leak_clean") is True for r in rows) else "no")
PY
)"
echo "  hole-deref hashes-only (Axis D leak_clean present): $LEAK_CLEAN"

fail=0
python3 -c "import sys; sys.exit(0 if $SCORED>=$MIN_SCORED else 1)" || { echo "  FAIL only $SCORED rows fetched (< $MIN_SCORED) — BLOCKED, cannot confirm correctness"; fail=1; }
python3 -c "import sys; sys.exit(0 if $ACC>=$MIN_ACCURACY else 1)" || { echo "  FAIL accuracy $ACC < $MIN_ACCURACY"; fail=1; }
[ "$LEAK_CLEAN" = "yes" ] || { echo "  FAIL no hashes-only (D leak_clean) witness"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "── gate_correctness: VALUES CORRECT + holes sealed (exit 0) ──"
else
  echo "── gate_correctness: NOT SETTLED (exit 1) ──"
fi
exit $fail
