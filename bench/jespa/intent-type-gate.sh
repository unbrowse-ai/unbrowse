#!/usr/bin/env bash
# intent-type-gate.sh — witness: the jespa energy classifier beats the stronger baseline
# (majority / keyword nearest-centroid) on route access-pattern type classification, by a
# real margin (mean lift >=0.08 across 30 seeds), n>=20 per seed. Re-runs from scratch.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
python3 intent_type_bench.py >/dev/null 2>&1 || { echo "[intent-type] run failed"; exit 1; }
python3 - <<'PY'
import json,sys
d=json.load(open("data/intent_type_result.json")); s=d["seeds"]
lifts = [x["jespa_acc"]-x["baseline_acc"] for x in s]
mean_lift = sum(lifts)/len(lifts)
ok = len(s)>=20 and all(x["n_eval"]>=20 for x in s) and mean_lift >= 0.08
for x in s[:10]: print(f"  seed {x['seed']:2d}: jespa={x['jespa_acc']:.4f} base={x['baseline_acc']:.4f} lift={x['jespa_acc']-x['baseline_acc']:+.3f}")
print(f"  ... {len(s)} seeds total, mean lift={mean_lift:+.4f}  jespa_mean={sum(x['jespa_acc'] for x in s)/len(s):.4f}")
print("[intent-type]","PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
PY