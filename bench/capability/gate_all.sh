#!/usr/bin/env bash
# gate_all.sh — the FINISH-THE-JOB witness. Exits 0 only when ALL FIVE capability axes
# are settled with genuine evidence:
#   - every unit suite passes, AND
#   - history.jsonl holds a real passing record for each axis (A indexing, B execution,
#     C auth, D security, E value-correctness), produced by the live drivers (not fabricated).
#     E (value-correctness) is produced by gate_correctness.sh and proves the returned values
#     match known ground truth — not just that two witnesses agree (the old blind spot).
# Fast + repeatable: it verifies recorded evidence; the slow live drivers generate it once.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HIST="$HERE/history.jsonl"
fail=0

echo "── gate_all: unit suites ──"
for t in test_score_retrieval test_score_execute test_live_protocol; do
  if python3 "$HERE/$t.py" >/dev/null 2>&1; then echo "  ok   $t"; else echo "  FAIL $t"; fail=1; fi
done

echo "── gate_all: Axis A retrieval scorer (fixture gate) ──"
if bash "$HERE/gate.sh" >/dev/null 2>&1; then echo "  ok   fixture retrieval gate"; else echo "  FAIL fixture retrieval gate"; fail=1; fi

echo "── gate_all: per-axis live evidence ──"
python3 - "$HIST" <<'PY' || fail=1
import json, sys
rows = []
try:
    for ln in open(sys.argv[1]):
        ln = ln.strip()
        if ln:
            rows.append(json.loads(ln))
except FileNotFoundError:
    print("  FAIL no history.jsonl"); sys.exit(1)

def passes(axis, pred):
    return any(r.get("axis") == axis and pred(r) for r in rows)

# A — action-retrieval / indexing COVERAGE across all 3 tiers (R reddit, H hardest-scrape,
# A automation): a live multi-tier explain() run where overall coverage>=0.75 AND every tier
# is covered. Proves breadth, not just reddit.
A = passes("A_indexing", lambda r: r.get("benchmark") == "multi_tier" and r.get("gate") == "true"
           and r.get("coverage") is True and r.get("tiers_covered") is True)
# B — execution: genuine content-bound two-witness live green, DISTINCT sessions
B = passes("B_execute", lambda r: r.get("source") == "live" and r.get("gate") == "true"
           and r.get("content_key") and r.get("expect_ok")
           and r.get("witnesses") and r["witnesses"][0]["session_id"] != r["witnesses"][1]["session_id"])
# C — auth: an authenticated live read returned auth-only data
C = passes("C_auth", lambda r: r.get("source") == "live" and r.get("gate") == "true" and r.get("authed") is True)
# D — security: a leak-scan over a live execute found NO secret on the wire
D = passes("D_security", lambda r: r.get("leak_clean") is True)
# E — value CORRECTNESS: returned values match known immutable ground truth (two-witness),
# accuracy>=0.85 over >=6 actually-fetched rows. Closes the reproducibility-only blind spot —
# a consistently-WRONG answer can pass A-D but never E. Produced by gate_correctness.sh.
E = passes("E_correctness", lambda r: r.get("gate") == "true"
           and float(r.get("accuracy") or 0) >= 0.85 and int(r.get("scored") or 0) >= 6)

ok = True
for name, v in (("A indexing", A), ("B execution", B), ("C auth", C), ("D security", D), ("E correctness", E)):
    print(f"  {'ok  ' if v else 'FAIL'} axis {name}")
    ok = ok and v
sys.exit(0 if ok else 1)
PY

if [ "$fail" -eq 0 ]; then
  echo "── gate_all: ALL FIVE AXES SETTLED (exit 0) ──"
else
  echo "── gate_all: NOT FINISHED (exit 1) ──"
fi
exit $fail
