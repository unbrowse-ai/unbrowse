#!/usr/bin/env bash
# audit-coverage.sh — one-command harness-harness loop.
#
# Runs the full extraction audit pipeline:
#   1. inspect-page-signals (curl + report of what signals exist)
#   2. bench-local.sh --force-capture (live capture + extractor)
#   3. bench-vs-inspect (delta report)
#
# The agent then reads the delta report and knows exactly which URLs
# are CONFIRMED_PASS / PRODUCT_WIN / EXTRACTION_GAP / etc. No guesswork.
#
# Usage:
#   bash scripts/audit-coverage.sh                            # full baseline
#   bash scripts/audit-coverage.sh --corpus /tmp/sample.txt   # custom corpus
#   bash scripts/audit-coverage.sh --use-source               # run against src/
#   bash scripts/audit-coverage.sh --timeout 150              # bench timeout
#
# Output:
#   .bench-local/results.jsonl   — bench rows
#   .bench-local/inspect.jsonl   — ground-truth rows (resumable)
#   .bench-local/coverage.txt    — human-readable delta report
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORPUS="$SCRIPT_DIR/corpus/benchmark-baseline.txt"
USE_SOURCE=""
TIMEOUT=120
SKIP_INSPECT=0
SKIP_BENCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --corpus) shift; CORPUS="${1:-}"; shift ;;
    --use-source) USE_SOURCE="--use-source"; shift ;;
    --timeout) shift; TIMEOUT="${1:-120}"; shift ;;
    --skip-inspect) SKIP_INSPECT=1; shift ;;
    --skip-bench) SKIP_BENCH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$CORPUS" ]; then
  echo "[audit-coverage] corpus not found: $CORPUS" >&2
  exit 1
fi

N=$(wc -l < "$CORPUS" | tr -d ' ')
echo "[audit-coverage] corpus: $CORPUS ($N URLs)"
echo "[audit-coverage] timeout: ${TIMEOUT}s/url"

mkdir -p .bench-local

if [ "$SKIP_INSPECT" -eq 0 ]; then
  echo ""
  echo "=== Phase 1: inspect-page-signals (ground truth) ==="
  python3 "$SCRIPT_DIR/inspect-page-signals.py" --corpus "$CORPUS" --summary > .bench-local/coverage-inspect.txt 2>&1
  tail -n 40 .bench-local/coverage-inspect.txt | head -25
fi

if [ "$SKIP_BENCH" -eq 0 ]; then
  echo ""
  echo "=== Phase 2: bench-local --force-capture (product behavior) ==="
  bash "$SCRIPT_DIR/bench-local.sh" --corpus-file "$CORPUS" --timeout "$TIMEOUT" --force-capture $USE_SOURCE > .bench-local/coverage-bench.log 2>&1
  tail -n 10 .bench-local/coverage-bench.log
fi

echo ""
echo "=== Phase 3: bench-vs-inspect (delta) ==="
python3 "$SCRIPT_DIR/bench-vs-inspect.py" .bench-local/results.jsonl .bench-local/inspect.jsonl > .bench-local/coverage.txt 2>&1
cat .bench-local/coverage.txt
echo ""
echo "[audit-coverage] full delta report: .bench-local/coverage.txt"
echo "[audit-coverage] per-URL bench rows: .bench-local/results.jsonl"
echo "[audit-coverage] per-URL inspect signals: .bench-local/inspect.jsonl"
