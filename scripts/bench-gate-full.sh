#!/usr/bin/env bash
# bench-gate-full.sh — run the full release-gate bench pipeline.
#
#   1. bench-gate.sh             collect per-probe artifacts (no verdict)
#   2. bench-gate-judge.ts       LLM judge renders per-probe verdicts
#   3. bench-gate-compare.ts     compare verdicts vs baseline + thresholds
#
# Env:
#   ANTHROPIC_API_KEY     required unless --dry-run-judge
#   CORPUS                override corpus (default: harness/probes/corpus-gate.txt)
#   UNBROWSE              override CLI (default: unbrowse)
#   OUT_DIR               override .bench-gate root
#
# Flags:
#   --dry-run-judge       skip the real LLM call; emit stub verdicts (for harness↔compare contract testing)
#   --soft                pass --soft to compare (PR-comment mode: never exits non-zero)
#   --limit N             stop the harness after N probes
#
set -euo pipefail

DRY_RUN_JUDGE=0
SOFT=0
LIMIT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run-judge) DRY_RUN_JUDGE=1 ;;
    --soft) SOFT=1 ;;
    --limit) shift; LIMIT="${1:-0}" ;;
    *) echo "bench-gate-full: unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CORPUS="${CORPUS:-harness/probes/corpus-gate.txt}"
export OUT_DIR="${OUT_DIR:-.bench-gate}"
export UNBROWSE="${UNBROWSE:-unbrowse}"
export LIMIT

echo "[bench-gate-full] phase 1/3 — harness collect"
RUN_DIR="$(bash scripts/bench-gate.sh | tail -1)"
if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
  echo "bench-gate harness did not produce a run dir" >&2
  exit 1
fi
echo "[bench-gate-full] run_dir=$RUN_DIR"

echo "[bench-gate-full] phase 2/3 — agent judge"
JUDGE_ARGS=(--artifacts "$RUN_DIR")
if [ "$DRY_RUN_JUDGE" = "1" ]; then
  JUDGE_ARGS+=(--dry-run)
fi
bun scripts/bench-gate-judge.ts "${JUDGE_ARGS[@]}"

echo "[bench-gate-full] phase 3/3 — compare vs baseline"
COMPARE_ARGS=(--artifacts "$RUN_DIR")
if [ "$SOFT" = "1" ]; then
  COMPARE_ARGS+=(--soft)
fi
bun scripts/bench-gate-compare.ts "${COMPARE_ARGS[@]}"
