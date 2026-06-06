#!/usr/bin/env bash
# reproduce-all.sh — the discrete-structure / mechanism wins of energy-based selection:
# route ranking (4.6x top-1), access-type classification (~2x), the closed-loop and
# runtime-ship energy gates, and content-addressed cache reuse. Each line is a real
# witness that exits 0 only when the claim reproduces.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
bash "$HERE/route-ranking-gate.sh"
bash "$HERE/intent-type-gate.sh"
bash "$ROOT/bench/ebm-closed-loop-gate.sh"
bash "$ROOT/bench/ebm-runtime-ship-gate.sh"
python3 "$ROOT/paper/reference/bench/bench_reuse.py"
