#!/usr/bin/env bash
# test-isolate.sh — run one failing test in isolation and dump structured
# context the calling agent needs to fix it. Designed for the post-WIP
# triage flow where 22 tests fail across 1 file: read each one's evidence
# without re-running the whole suite.
#
# Usage:
#   scripts/test-isolate.sh <test-file-pattern> [--name "<test name regex>"] [--json]
#
# Examples:
#   scripts/test-isolate.sh rank-endpoints
#   scripts/test-isolate.sh rank-endpoints --name "prefers observed company api"
#   scripts/test-isolate.sh rank-endpoints --json > out.json
#
# What it emits (text mode, default):
#   1. Located test file
#   2. Bun test output (full, captured)
#   3. Parsed failure: assertion line, expected vs received, stack trace
#   4. Test source (the `it(...)` block that failed)
#   5. SUT excerpts: imported source files referenced in the test
#   6. Recent commits touching SUT files (last 10)
#
# JSON mode emits the same fields as a single object so an agent harness
# can ingest one test's evidence per call.

set -u

PATTERN="${1:-}"
NAME=""
JSON=0
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PATTERN" ]]; then
  echo "usage: $0 <test-file-pattern> [--name <regex>] [--json]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. Find the test file
TEST_FILE=$(find tests backend/tests packages -path '*/node_modules' -prune -o -name "*${PATTERN}*.test.ts" -print 2>/dev/null | head -1)
if [[ -z "$TEST_FILE" ]]; then
  echo "no test file matched pattern: $PATTERN" >&2
  exit 1
fi

# 2. Run the test in isolation (capture both streams)
LOG=$(mktemp)
TEST_ARGS=("./$TEST_FILE")
if [[ -n "$NAME" ]]; then
  TEST_ARGS+=(--test-name-pattern "$NAME")
fi
bun test "${TEST_ARGS[@]}" >"$LOG" 2>&1
EXIT=$?

# 3. Parse the first failure
ASSERTION_LINE=$(grep -m1 -E '^\s+at <anonymous> \(' "$LOG" | head -1)
EXPECTED=$(grep -m1 -A1 'Expected' "$LOG" | head -3)
RECEIVED=$(grep -m1 -A1 'Received' "$LOG" | head -3)
FAIL_NAME=$(grep -m1 -E '^\(fail\)' "$LOG" | sed -E 's/\(fail\) (.*) \[.*$/\1/')
FAIL_FILE_LINE=$(echo "$ASSERTION_LINE" | sed -E 's/.*\((.*):([0-9]+):[0-9]+\)$/\1:\2/')

# 4. Imports referenced by the test (= candidate SUT files)
IMPORTS=$(grep -E "^import .* from \"" "$TEST_FILE" | grep -oE '"[^"]+"' | tr -d '"' | grep -vE '^(bun:|node:|@?[a-z][a-z0-9-]*$|@[a-z][a-z0-9-]*/)' | head -10)

# Resolve relative imports to absolute paths
SUT_FILES=()
while IFS= read -r imp; do
  [[ -z "$imp" ]] && continue
  if [[ "$imp" == ./* || "$imp" == ../* ]]; then
    resolved=$(cd "$(dirname "$TEST_FILE")" && cd "$(dirname "$imp")" 2>/dev/null && pwd)/$(basename "$imp")
    for ext in .ts .tsx .js index.ts; do
      candidate="${resolved%.*}${ext}"
      if [[ -f "$candidate" ]]; then SUT_FILES+=("$candidate"); break; fi
      if [[ -f "${resolved}${ext}" ]]; then SUT_FILES+=("${resolved}${ext}"); break; fi
      if [[ -f "${resolved}/${ext}" ]]; then SUT_FILES+=("${resolved}/${ext}"); break; fi
    done
  elif [[ "$imp" == @/* ]]; then
    SUT_FILES+=("$ROOT/${imp#@/}")
  fi
done <<< "$IMPORTS"

if [[ "$JSON" -eq 1 ]]; then
  jq -n \
    --arg test_file "$TEST_FILE" \
    --arg fail_name "$FAIL_NAME" \
    --arg fail_loc "$FAIL_FILE_LINE" \
    --arg expected "$EXPECTED" \
    --arg received "$RECEIVED" \
    --arg log "$(cat "$LOG")" \
    --arg exit "$EXIT" \
    --argjson sut_files "$(printf '%s\n' "${SUT_FILES[@]}" | jq -R . | jq -s .)" \
    '{test_file: $test_file, exit: ($exit|tonumber), fail_name: $fail_name, fail_location: $fail_loc, expected: $expected, received: $received, sut_files: $sut_files, full_log: $log}'
  exit "$EXIT"
fi

# Text mode
echo "=== test-isolate ==="
echo "test_file:      $TEST_FILE"
[[ -n "$NAME" ]] && echo "name_filter:    $NAME"
echo "exit:           $EXIT"
echo
if [[ -n "$FAIL_NAME" ]]; then
  echo "=== FAILED ==="
  echo "name:           $FAIL_NAME"
  echo "location:       $FAIL_FILE_LINE"
  echo
  echo "=== assertion ==="
  echo "$EXPECTED"
  echo "$RECEIVED"
  echo

  if [[ -n "$FAIL_FILE_LINE" ]]; then
    file="${FAIL_FILE_LINE%:*}"
    line="${FAIL_FILE_LINE##*:}"
    if [[ -f "$file" && -n "$line" ]]; then
      start=$((line > 8 ? line - 8 : 1))
      end=$((line + 8))
      echo "=== test source ($file:$start-$end) ==="
      awk -v s="$start" -v e="$end" -v hl="$line" 'NR>=s && NR<=e {prefix=(NR==hl?">>":"  "); printf "%s %4d  %s\n", prefix, NR, $0}' "$file"
      echo
    fi
  fi
fi

if [[ ${#SUT_FILES[@]} -gt 0 ]]; then
  echo "=== SUT files (referenced by test) ==="
  for f in "${SUT_FILES[@]}"; do
    if [[ -f "$f" ]]; then
      lines=$(wc -l < "$f" | tr -d ' ')
      echo "  $f ($lines lines)"
    fi
  done
  echo
  echo "=== recent commits touching SUT ==="
  git log --oneline -10 -- "${SUT_FILES[@]}" 2>/dev/null
  echo
fi

echo "=== full log ==="
cat "$LOG"

rm -f "$LOG"
exit "$EXIT"
