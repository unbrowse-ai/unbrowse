#!/usr/bin/env bash
# bench-loop.sh — the closed-loop primitive for the 100% coverage target.
#
# One pass: bench → triage → verdict.
#   - Zero product-fails (only blocks left) → exit 0 (100% coverage achieved).
#   - One or more product-fails → exit 1, emit fail list to .bench-loop-fails.json
#     which the agent (me) reads and fixes. After the fix, caller re-runs.
#
# This is the outer ring of the "primitives that build primitives" pattern:
# the bench is a primitive, triage is a primitive, the loop glues them into
# a gate. Each product-fail the loop surfaces becomes a new probe after it
# is fixed (features-extend-the-benchmark).
#
# Usage:
#   bash scripts/bench-loop.sh --version 3.7.1 --corpus-size 15
set -uo pipefail

VERSION=""
CORPUS_SIZE=15
for arg in "$@"; do
  case "$arg" in
    --version) shift; VERSION="${1:-}"; shift || true ;;
    --corpus-size) shift; CORPUS_SIZE="${1:-15}"; shift || true ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION=$(npm view unbrowse version 2>/dev/null)
fi

echo "[bench-loop] version=$VERSION corpus=$CORPUS_SIZE"

# Step 1: run the bench (capture stdout for triage source-of-truth)
BENCH_LOG=$(mktemp)
bash scripts/benchmark-turbobox-parallel.sh --versions "$VERSION" --corpus-size "$CORPUS_SIZE" 2>&1 | tee "$BENCH_LOG"

# Step 2: find the result file. benchmark-turbobox-parallel.sh prints
# "results dir: PATH (not cleaned)" on success.
RESULTS_DIR=$(grep -oE 'results dir: [^ ]+' "$BENCH_LOG" | tail -1 | awk '{print $3}')
if [ -z "$RESULTS_DIR" ] || [ ! -d "$RESULTS_DIR" ]; then
  echo "[bench-loop] ✗ no results dir found"
  rm -f "$BENCH_LOG"
  exit 2
fi

RESULT_FILE="$RESULTS_DIR/$VERSION.json"
if [ ! -f "$RESULT_FILE" ]; then
  echo "[bench-loop] ✗ no result file at $RESULT_FILE"
  rm -f "$BENCH_LOG"
  exit 2
fi

# Step 3: triage
TRIAGE=$(bash scripts/bench-triage.sh file "$RESULT_FILE")
echo "$TRIAGE" > .bench-loop-triage.json

fail_count=$(echo "$TRIAGE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('fail_count', 0))")
pass_count=$(echo "$TRIAGE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('pass_count', 0))")
block_count=$(echo "$TRIAGE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('block_count', 0))")

echo ""
echo "[bench-loop] pass=$pass_count fail=$fail_count block=$block_count"

if [ "$fail_count" = "0" ]; then
  rm -f .bench-loop-fails.json
  echo "[bench-loop] ✓ 100% coverage (only browser-blocks remain)"
  rm -f "$BENCH_LOG"
  exit 0
else
  echo "$TRIAGE" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
json.dump(d['fails'], open('.bench-loop-fails.json','w'), indent=2)
"
  echo "[bench-loop] ✗ $fail_count product fails — see .bench-loop-fails.json"
  rm -f "$BENCH_LOG"
  exit 1
fi
