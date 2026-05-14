#!/usr/bin/env bash
# bench-gate-full.sh — run the release-gate bench pipeline.
#
# Phases:
#   1. bench-gate.sh             collect per-probe artifacts (no verdict)
#   2. bench-gate-judge.ts       PREP a judge bundle for the agent
#   3. [agent in-thread]         read judge.bundle.md, write verdict.json
#   4. bench-gate-judge.ts --validate   verify the agent's verdict.json
#   5. bench-gate-compare.ts     compare verdicts vs baseline + thresholds
#
# This script runs phases 1 + 2 then STOPS. The agent running this script
# (Claude Code in-thread) reads the judge bundle and writes verdict.json,
# then runs phases 4 + 5. The script never auto-judges — see CLAUDE.md
# "harness makes visible, agent judges".
#
# Env:
#   CORPUS                override corpus (default: harness/probes/corpus-gate.txt)
#   UNBROWSE              override CLI (default: unbrowse)
#   OUT_DIR               override .bench-gate root
#
# Flags:
#   --dry-run-judge       skip the agent step entirely; auto-fills stub
#                         verdicts (lane-shaped only — for harness↔compare
#                         contract testing, NOT a real judgment)
#   --soft                pass --soft to compare (PR-comment mode: never exits non-zero)
#   --limit N             stop the harness after N probes
#
set -euo pipefail

DRY_RUN_JUDGE=0
SOFT=0
LIMIT="${LIMIT:-0}"

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

echo "[bench-gate-full] phase 1/5 — harness collect"
RUN_DIR="$(bash scripts/bench-gate.sh | tail -1)"
if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
  echo "bench-gate harness did not produce a run dir" >&2
  exit 1
fi
echo "[bench-gate-full] run_dir=$RUN_DIR"

echo "[bench-gate-full] phase 2/5 — prep judge bundle"
if [ "$DRY_RUN_JUDGE" = "1" ]; then
  bun scripts/bench-gate-judge.ts --artifacts "$RUN_DIR" --dry-run

  echo "[bench-gate-full] phase 4/5 — validate (dry-run mode)"
  bun scripts/bench-gate-judge.ts --artifacts "$RUN_DIR" --validate

  echo "[bench-gate-full] phase 5/5 — compare vs baseline"
  COMPARE_ARGS=(--artifacts "$RUN_DIR")
  if [ "$SOFT" = "1" ]; then COMPARE_ARGS+=(--soft); fi
  bun scripts/bench-gate-compare.ts "${COMPARE_ARGS[@]}"
  exit $?
fi

# Real (agent-judged) mode: prep + stop.
bun scripts/bench-gate-judge.ts --artifacts "$RUN_DIR"

echo ""
echo "[bench-gate-full] stopped at phase 3/5 — agent judge required."
echo "[bench-gate-full] Agent (you, in this conversation):"
echo "[bench-gate-full]   1. Read $RUN_DIR/judge.bundle.md"
echo "[bench-gate-full]   2. Write $RUN_DIR/verdict.json"
echo "[bench-gate-full]   3. Run: bun scripts/bench-gate-judge.ts --artifacts $RUN_DIR --validate"
COMPARE_FLAGS=""
if [ "$SOFT" = "1" ]; then COMPARE_FLAGS=" --soft"; fi
echo "[bench-gate-full]   4. Run: bun scripts/bench-gate-compare.ts --artifacts $RUN_DIR$COMPARE_FLAGS"
echo ""
echo "$RUN_DIR"
