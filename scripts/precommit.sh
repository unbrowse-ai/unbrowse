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

if has_match '^(src/client/index\.ts|src/runtime/|src/cli\.ts|packages/skill/README\.md|tests/client-registration\.test\.ts|tests/runtime-setup\.test\.ts)$'; then
  run_tests tests/client-registration.test.ts tests/runtime-setup.test.ts
fi

if has_match '^(src/kuri/|src/runtime/paths\.ts|packages/skill/|tests/runtime-(paths|setup)\.test\.ts|scripts/check-packaged-kuri\.sh|packages/skill/scripts/)'; then
  echo "[pre-commit] checking packaged Kuri path"
  bash scripts/check-packaged-kuri.sh
fi

if has_match '^(src/execution/|src/orchestrator/|src/capture/|src/intent-match\.ts|src/extraction/|src/reverse-engineer/|tests/(cli-input-payload|input-payload-ingestion|intent-match|graph-filters)\.test\.ts)$'; then
  run_tests \
    tests/cli-input-payload.test.ts \
    tests/input-payload-ingestion.test.ts \
    tests/intent-match.test.ts \
    tests/graph-filters.test.ts
fi


if has_match '^(packages/skill/package\.json|packages/skill/scripts/|scripts/publish-preview-cli\.mjs|\.release-it\.json)$'; then
  echo "[pre-commit] asserting opaque npm tarball"
  bun run check:opaque-tarball
fi

if has_match '^(docs/|README\.md|packages/skill/README\.md|packages/skill/SKILL\.md|scripts/leak-guard\.sh)$'; then
  echo "[pre-commit] leak-guard: scanning public-reachable paths for alpha"
  bash scripts/leak-guard.sh
fi
# Doc-delta probe: when the staged diff carries shipping-surface signals
# (new workspace member, [[bin]], deploy target, new top-level dir, new
# manifest below root) AND no canonical doc (README / architecture /
# CHANGELOG) was touched, print evidence to stderr. Never blocks.
bash scripts/precommit-doc-delta.sh || true

echo "[pre-commit] fast checks passed"
