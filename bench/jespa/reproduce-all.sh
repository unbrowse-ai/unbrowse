#!/usr/bin/env bash
# reproduce-all.sh — Fractal JESPA, fully reproducible end to end. Runs every witness:
# the cross primitive, the 2 unbrowse-as-tools WINS, the plank→cross geometry, and the
# accumulating ledger-gate at the genuine win count. Exit 0 = all the real claims reproduce.
set -uo pipefail
JP=/Users/lekt9/Projects/jesus-pattern
EB=/Users/lekt9/Projects/ebllm
DS=/Users/lekt9/Projects/aiko-claude-distill
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
run(){ local n="$1"; shift; printf '  %-52s ' "$n"; if timeout 600 "$@" >/dev/null 2>&1; then echo "OK"; pass=$((pass+1)); else echo "RED (exit $?)"; fail=$((fail+1)); fi; }

echo "== Fractal JESPA — reproduce-all =="
echo "-- the cross primitive (selector) --"
run "jepa selftest (jepa(jepa)=jepa, breaks@7)"            bash -c "cd $JP && ./jepa selftest"
run "plank→cross geometry (two roads, real corpus)"       env DISTILL_CORPUS=$DS/data/claude_traces.jsonl python3 $JP/skills/jesus-pattern/references/examples/jepa_build/distill_plank_cross.py --selftest

echo "-- unbrowse-as-tools WINS --"
run "route-EBM: energy ranks unbrowse routes (4.6x)"      bash $EB/route_ebm_gate.sh
run "intent-type: energy classifies access-pattern (2.1x)" bash $HERE/intent-type-gate.sh

echo "-- the accumulating ledger-gate (genuine win count = 2) --"
run "jespa-benchmarks-gate @ target 2"                     env JESPA_WIN_TARGET=2 bash $HERE/jespa-benchmarks-gate.sh

echo ""
echo "== $pass green / $fail red =="
[ "$fail" -eq 0 ] && { echo "FRACTAL-JESPA REPRODUCED — all real claims green"; exit 0; } || exit 1
