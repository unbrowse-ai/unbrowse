#!/usr/bin/env bash
# verify.sh - autonomous benchmax wave verifier.
#
# Chain (each phase is OPTIONAL; agent sets env to skip phases):
#   1. measure  - fire fresh bench if latest run is stale (or reuse)
#   2. classify - structural verdict.json from per-probe artifacts
#   3. compare  - gate.json verdict via bench-gate-compare.ts
#   4. delta    - per-probe verdict flips vs prior run
#   5. summary  - human-readable wave row in ledger
#
# Exit code:
#   0 if gate.passed=true (loop is converged; agent can stop)
#   0 if gate.passed=false (loop is unconverged; agent reads ship.sh + next-blocker.sh for the next fix)
# Never non-zero on legitimate failing-gate - the substrate principle
# says "harness collects, agent judges". Non-zero exits are reserved for
# infrastructure errors (collector crashed, manifest missing).
#
# Env:
#   UNBROWSE_BENCH_SKIP_MEASURE    (1)  skip phase 1, reuse latest
#   UNBROWSE_BENCH_SKIP_CLASSIFY   (1)  skip phase 2, keep existing verdict.json
#   (forwards UNBROWSE_BENCH_MAX_AGE_MIN / _CONCURRENCY / _PROBE_TIMEOUT_MS to measure.sh)

set -uo pipefail
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "$SCAFFOLD/../.." && pwd)"
cd "$PROJECT"
LEDGER="$SCAFFOLD/ledgers/lanes.jsonl"
LOG_DIR="$SCAFFOLD/logs"
mkdir -p "$LOG_DIR"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Phase 1: measure
RUN_DIR=""
if [ "${UNBROWSE_BENCH_SKIP_MEASURE:-0}" = "1" ]; then
  RUN_DIR=$(ls -dt .bench-gate/20260*/ 2>/dev/null | head -1)
  RUN_DIR="${RUN_DIR%/}"
  echo "[verify] skip-measure: reusing $RUN_DIR" >&2
else
  RUN_DIR=$(bash "$SCAFFOLD/scripts/measure.sh" 2>>"$LOG_DIR/wave-measure.log")
  if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
    echo "[verify] measure.sh produced no run-dir; see $LOG_DIR/wave-measure.log" >&2
    exit 1
  fi
fi
echo "[verify] run_dir=$RUN_DIR"

# Phase 2: classify
if [ "${UNBROWSE_BENCH_SKIP_CLASSIFY:-0}" = "1" ] && [ -f "$RUN_DIR/verdict.json" ]; then
  echo "[verify] skip-classify: reusing existing verdict.json" >&2
else
  bash "$SCAFFOLD/scripts/auto-classify.sh" "$RUN_DIR" 2>>"$LOG_DIR/wave-classify.log"
fi
if [ ! -f "$RUN_DIR/verdict.json" ]; then
  echo "[verify] verdict.json still missing after classify" >&2
  exit 1
fi

# Phase 3: compare → gate.json
BASELINE="harness/probes/bench-gate-baseline.json"
if [ ! -f "$BASELINE" ]; then
  echo "[verify] baseline $BASELINE missing; bench-gate-compare needs it" >&2
fi
bun scripts/bench-gate-compare.ts --artifacts "$RUN_DIR" --baseline "$BASELINE" --soft 2>>"$LOG_DIR/wave-compare.log" >>"$LOG_DIR/wave-compare.log" || true
if [ ! -f "$RUN_DIR/gate.json" ]; then
  echo "[verify] gate.json missing after compare; see $LOG_DIR/wave-compare.log" >&2
  exit 1
fi

# Read gate verdict for logging
GATE_PASSED=$(python3 -c "import json;print(json.load(open('$RUN_DIR/gate.json')).get('passed'))")
INDEX_COV=$(python3 -c "import json;g=json.load(open('$RUN_DIR/gate.json'));print(g.get('coverage',{}).get('index_coverage',0))")
RETRIEVE_COV=$(python3 -c "import json;g=json.load(open('$RUN_DIR/gate.json'));print(g.get('coverage',{}).get('retrieve_coverage',0))")
echo "[verify] gate.passed=$GATE_PASSED  index=$INDEX_COV  retrieve=$RETRIEVE_COV"

# Phase 4: per-probe delta vs prior run
PRIOR=$(ls -dt .bench-gate/20260*/ 2>/dev/null | sed -n '2p')
PRIOR="${PRIOR%/}"
if [ -n "$PRIOR" ] && [ -f "$PRIOR/verdict.json" ]; then
  python3 - "$PRIOR/verdict.json" "$RUN_DIR/verdict.json" >"$LOG_DIR/wave-delta.txt" 2>&1 <<'PYEOF'
import json, sys
a = json.load(open(sys.argv[1]))["verdicts"]
b = json.load(open(sys.argv[2]))["verdicts"]
A = {v["probe_id"]: (v["index_verdict"], v["retrieve_verdict"]) for v in a}
B = {v["probe_id"]: (v["index_verdict"], v["retrieve_verdict"]) for v in b}
flips = []
for k in sorted(set(A) | set(B)):
    if A.get(k) != B.get(k): flips.append((k, A.get(k), B.get(k)))
print(f"per-probe verdict flips ({len(flips)} of {len(B)}):")
for k, old, new in flips:
    print(f"  {k}: {old} -> {new}")
PYEOF
  head -20 "$LOG_DIR/wave-delta.txt"
fi

# Phase 5: ledger row
printf '{"ts":"%s","phase":"verify","run_dir":"%s","gate":{"passed":"%s","index":%s,"retrieve":%s}}\n' "$TS" "$RUN_DIR" "$GATE_PASSED" "$INDEX_COV" "$RETRIEVE_COV" >> "$LEDGER"
echo "[verify] wave logged: $LEDGER"

if [ "$GATE_PASSED" = "True" ]; then
  echo "[verify] CONVERGED. Gate is green. No further fix needed."
else
  echo "[verify] UNCONVERGED. Read ship.sh output or run scripts/next-blocker.sh for the next /meta-harness target."
fi
exit 0
