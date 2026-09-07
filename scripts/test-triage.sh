#!/usr/bin/env bash
# test-triage.sh — list every failing test as one structured row so the
# calling agent can iterate through them one at a time, calling
# test-isolate.sh on each. Avoids re-running the entire suite per test.
#
# Usage:
#   scripts/test-triage.sh [path]            # list failing tests as text
#   scripts/test-triage.sh --json [path]     # JSON array, one row per failure
#   scripts/test-triage.sh --next            # print one failing-test command
#                                            # for the agent to run, then stop
#
# Each row contains:
#   - test_file           (path to .test.ts)
#   - test_name           (the description string)
#   - isolate_command     (exact shell to debug it via test-isolate.sh)
#
# Workflow for a fixing agent:
#   1. Run scripts/test-triage.sh --json > .triage.json
#   2. For each row: run isolate_command, read evidence, fix code, re-run isolate
#   3. When isolate_command returns exit=0, mark row done; move to next
#   4. After all rows fixed, re-run scripts/test-triage.sh to confirm zero remain

set -u

MODE="text"
TEST_PATH="tests/"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) MODE="json"; shift ;;
    --next) MODE="next"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) TEST_PATH="$1"; shift ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CACHE="${TEST_TRIAGE_CACHE:-/tmp/test-triage-$(echo "$TEST_PATH" | tr '/' '_').log}"
LOG="$CACHE"
NOW=$(date +%s)
MTIME=$(stat -f %m "$CACHE" 2>/dev/null || stat -c %Y "$CACHE" 2>/dev/null || echo 0)
if [[ "${TEST_TRIAGE_REFRESH:-0}" == "1" || ! -s "$CACHE" || $((NOW - MTIME)) -gt 600 ]]; then
  bun test "$TEST_PATH" >"$LOG" 2>&1
  EXIT=$?
else
  EXIT=0  # using cached run
fi
EXIT=$?

# Each fail line: "(fail) <suite> > <test name> [123ms]"
FAILS=$(grep -E '^\(fail\)' "$LOG" | sed -E 's/^\(fail\) (.*) \[[0-9.]+m?s\]$/\1/')
if [[ -z "$FAILS" ]]; then
  if [[ "$MODE" == "json" ]]; then echo "[]"; else echo "no failing tests"; fi
  exit 0
fi

# For each failure, find the test file by grepping its test name.
# Note: bun test output gives "suite > test", but the it() string is just the
# trailing segment after the last " > ". Use that to grep test files.
emit_row() {
  local full_name="$1"
  local short=$(echo "$full_name" | sed -E 's/.* > //')
  # Search every test file (root + backend + packages) for this it() name.
  local test_file
  test_file=$(grep -rl --include='*.test.ts' -F "$short" tests backend/tests packages 2>/dev/null | head -1)
  if [[ -z "$test_file" ]]; then test_file="(unknown)"; fi
  # Pick a pattern key from the file path for isolate.sh
  local pattern
  pattern=$(basename "$test_file" .test.ts)
  local cmd="scripts/test-isolate.sh '$pattern' --name '$short'"
  if [[ "$MODE" == "json" ]]; then
    jq -nc \
      --arg test_file "$test_file" \
      --arg test_name "$full_name" \
      --arg short "$short" \
      --arg isolate_command "$cmd" \
      '{test_file: $test_file, test_name: $test_name, short: $short, isolate_command: $isolate_command}'
  else
    printf '%s\n  file:    %s\n  isolate: %s\n\n' "$full_name" "$test_file" "$cmd"
  fi
}

if [[ "$MODE" == "json" ]]; then
  echo "["
  first=1
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ $first -eq 0 ]] && echo ","
    first=0
    emit_row "$line"
  done <<< "$FAILS"
  echo "]"
elif [[ "$MODE" == "next" ]]; then
  next_line=$(echo "$FAILS" | head -1)
  emit_row "$next_line"
else
  count=$(echo "$FAILS" | wc -l | tr -d ' ')
  echo "=== $count failing tests in $TEST_PATH ==="
  echo
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    emit_row "$line"
  done <<< "$FAILS"
fi

# keep $LOG cached at $CACHE; set TEST_TRIAGE_REFRESH=1 to force re-run
exit 0
