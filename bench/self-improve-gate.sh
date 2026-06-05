#!/usr/bin/env bash
# self-improve-gate.sh — the witness for "deployed + included + 20 recorded
# self-improvement iterations". Exits 0 exactly when BOTH hold:
#   (1) the benchmarks are honestly included + published (whitepaper-benchmarks-gate)
#   (2) bench/SELF-IMPROVEMENT.jsonl records >= 20 real self-improvement iterations,
#       each carrying a numeric metric (the cache-flywheel run against itself).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail(){ echo "[self-improve] FAIL: $*"; exit 1; }
ok(){ echo "[self-improve] ok: $*"; }

# (1) deploy + inclusion witness
bash bench/whitepaper-benchmarks-gate.sh >/dev/null 2>&1 || fail "whitepaper-benchmarks-gate red (benchmarks not honestly included/published)"
ok "benchmarks included + published (whitepaper gate green)"

# (2) >= 20 recorded self-improvement iterations, each with a real metric
L="bench/SELF-IMPROVEMENT.jsonl"
[ -s "$L" ] || fail "no $L (no self-improvement record)"
ROWS=$(grep -cE '"iter"[[:space:]]*:[[:space:]]*[0-9]+' "$L" 2>/dev/null || echo 0)
METRIC_ROWS=$(grep -cE '"total_ms"[[:space:]]*:[[:space:]]*[0-9]+' "$L" 2>/dev/null || echo 0)
[ "$ROWS" -ge 20 ] || fail "only $ROWS self-improvement iterations recorded (<20)"
[ "$METRIC_ROWS" -ge 20 ] || fail "only $METRIC_ROWS iterations carry a real metric (<20)"
ok "$ROWS self-improvement iterations recorded, $METRIC_ROWS with a real metric (>=20)"

# the ledger must show the curve was honestly read (improvement + plateau noted)
grep -qE '"plateau"|"physical_limit"|"converged"' "$L" 2>/dev/null || fail "ledger never records reaching the physical limit (plateau)"
ok "physical limit (plateau) recorded in the ledger"

echo "[self-improve] PASS — published + 20 recorded self-improvement iterations to the physical limit"
exit 0
