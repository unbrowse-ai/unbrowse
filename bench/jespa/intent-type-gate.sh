#!/usr/bin/env bash
# intent-type-gate.sh — witness: the jespa energy classifier beats the stronger baseline
# (majority / keyword nearest-centroid) on route access-pattern type classification, by a
# real margin (>=0.10), both seeds, n>=20. Re-runs from scratch (no cached verdict).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
python3 intent_type_bench.py >/dev/null 2>&1 || { echo "[intent-type] run failed"; exit 1; }
python3 - <<'PY'
import json,sys
d=json.load(open("data/intent_type_result.json")); s=d["seeds"]
ok=len(s)>=2 and all(x["n_eval"]>=20 and (x["jespa_acc"]-x["baseline_acc"])>=0.10 for x in s)
for x in s: print(f"  seed {x['seed']}: jespa={x['jespa_acc']} base={x['baseline_acc']} lift={x['jespa_acc']-x['baseline_acc']:+.3f}")
print("[intent-type]","PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
PY
