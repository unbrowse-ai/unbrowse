#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

staged_files=()
while IFS= read -r file; do
  staged_files+=("$file")
done < <(git diff --cached --name-only --diff-filter=ACMR)

if [[ ${#staged_files[@]} -eq 0 ]]; then
  echo "[pre-commit] no staged files"
  exit 0
fi

has_match() {
  local pattern="$1"
  local file
  for file in "${staged_files[@]}"; do
    if [[ "$file" =~ $pattern ]]; then
      return 0
    fi
  done
  return 1
}

run_tests() {
  if [[ $# -eq 0 ]]; then
    return 0
  fi
  echo "[pre-commit] bun test $*"
  bun test "$@"
}

echo "[pre-commit] staged files: ${#staged_files[@]}"

if has_match '^(src/cli\.ts|SKILL\.md)$'; then
  echo "[pre-commit] checking SKILL.md sync"
  bun run check:skill-md
fi

if has_match '^(src/client/index\.ts|src/runtime/|src/cli\.ts|packages/skill/README\.md|SKILL\.md|tests/client-registration\.test\.ts|tests/runtime-setup\.test\.ts)$'; then
  run_tests tests/client-registration.test.ts tests/runtime-setup.test.ts
fi

if has_match '^(src/execution/|src/orchestrator/|src/capture/|src/intent-match\.ts|src/extraction/|src/reverse-engineer/|tests/(cli-input-payload|input-payload-ingestion|intent-match|graph-filters)\.test\.ts)$'; then
  run_tests \
    tests/cli-input-payload.test.ts \
    tests/input-payload-ingestion.test.ts \
    tests/intent-match.test.ts \
    tests/graph-filters.test.ts
fi

if has_match '^(tests/p0-p1-issues\\.json|scripts/fetch-p0-p1-issues\\.ts)$'; then
  if [[ "${SKIP_P0_P1_TESTS:-0}" != "1" ]]; then
    echo "[pre-commit] validating P0/P1 test cases"
    bun test tests/p0-p1-issues.test.ts
  fi
fi

echo "[pre-commit] fast checks passed"
