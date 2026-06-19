#!/usr/bin/env bash
# research-all-gate.sh — the loop witness: correctness (research+extract) AND performance (cache).
# Exits 0 only when BOTH the functional gate and the perf gate pass. No green without both.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
bash scripts/research-gate.sh || { echo "[all-gate] FAIL — functional"; exit 1; }
bash scripts/research-perf-gate.sh || { echo "[all-gate] FAIL — performance"; exit 1; }
echo "[all-gate] PASS — correctness + performance both witnessed"
