#!/usr/bin/env bash
# gate_current.sh — the CURRENT-binary maximization witness for the four-axis capability
# loop. Unlike gate_all.sh (ever-passed: green if an axis EVER passed), this checks the
# MOST RECENTLY RECORDED row per axis (history.jsonl append order = chronological), so it
# reflects how the CURRENT npm binary + backend perform on the latest live run.
#
# Exit 0 only when the latest A/B/C/D evidence all pass. RED until the loop makes the current
# binary pass every axis on a fresh `run_bench.sh --axes live` against staging. No fabricated
# green: it reads recorded live rows; the slow live drivers (the walk) generate them.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 - "$HERE/history.jsonl" <<'PY'
import json, sys
try:
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except FileNotFoundError:
    print("  FAIL no history.jsonl"); sys.exit(1)

def last(axis):
    rs = [r for r in rows if r.get("axis") == axis]
    return rs[-1] if rs else None  # last appended = latest evidence (no ts parsing)

checks = {
    "A indexing":  (last("A_indexing"),  lambda r: r.get("gate") == "true" and r.get("coverage") is True and r.get("tiers_covered") is True),
    "B execution": (last("B_execute"),   lambda r: r.get("source") == "live" and r.get("gate") == "true"),
    "C auth":      (last("C_auth"),       lambda r: r.get("gate") == "true" and r.get("authed") is True),
    "D security":  (last("D_security"),   lambda r: r.get("leak_clean") is True),
}
allok = True
print("── gate_current: latest live evidence per axis ──")
for name, (row, pred) in checks.items():
    ok = bool(row) and pred(row)
    extra = "" if row else " (no evidence — run the live bench)"
    print(f"  {'ok  ' if ok else 'FAIL'} axis {name}{extra}")
    allok = allok and ok
sys.exit(0 if allok else 1)
PY
