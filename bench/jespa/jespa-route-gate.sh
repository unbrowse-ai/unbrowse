#!/usr/bin/env bash
# jespa-route-gate.sh — the witness for "unbrowse ranking is JESPA-based and beats baseline".
# Honest, exit-able, reproducible. NOT a claim to beat Exa SOTA / browsecomp (teacher-ceiling,
# proven unachievable for a tiny ranker this session) — the WINNABLE benchmark: route RETRIEVAL.
#
# On a held-out split of a REAL route corpus (the in-repo .bench-gate captures), a JESPA ranker
# (encode intent -> predict route latent -> energy-rank candidates) must rank the true route
# above distractors BETTER than the keyword/back-off baseline — R@1 lift real and two-seed stable.
#
# Exit 0 iff data/jespa_route_result.json shows:
#   jespa_r_at_1 > baseline_r_at_1 by >= MARGIN, on BOTH seeds, n_eval >= MIN_EVAL.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
R=data/jespa_route_result.json
MARGIN=0.05
MIN_EVAL=100
fail(){ echo "[jespa-route] FAIL: $*"; exit 1; }
[ -f "$R" ] || fail "no result yet — run the jespa route benchmark (build extractor -> ranker -> scorer)"
python3 - "$R" "$MARGIN" "$MIN_EVAL" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); margin=float(sys.argv[2]); mineval=int(sys.argv[3])
seeds = d.get("seeds", [])
if len(seeds) < 2: print(f"[jespa-route] FAIL: need >=2 seeds, got {len(seeds)}"); sys.exit(1)
ok = True
for s in seeds:
    je, ba, n = s.get("jespa_r_at_1",0), s.get("baseline_r_at_1",0), s.get("n_eval",0)
    lift = je - ba
    print(f"  seed {s.get('seed')}: jespa R@1={je:.3f} baseline R@1={ba:.3f} lift={lift:+.3f} n={n}")
    if not (n >= mineval and lift >= margin): ok = False
print(f"[jespa-route] {'PASS' if ok else 'FAIL'} — jespa beats baseline R@1 by >= {margin} on both seeds (n>={mineval})")
sys.exit(0 if ok else 1)
PY
