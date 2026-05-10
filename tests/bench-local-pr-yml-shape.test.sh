#!/usr/bin/env bash
# Falsifier: pins structural shape of .github/workflows/bench-local-pr.yml.
# Each assertion prints PASS/FAIL with reason; exits nonzero on any FAIL.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
YML="$ROOT/.github/workflows/bench-local-pr.yml"
FAILS=0
PASSES=0

check() {
  local name="$1" cond="$2" reason="$3"
  if eval "$cond" >/dev/null 2>&1; then
    echo "PASS: $name"
    PASSES=$((PASSES+1))
  else
    echo "FAIL: $name — $reason"
    FAILS=$((FAILS+1))
  fi
}

# 1. Exists and non-empty
check "file exists & non-empty" "[ -s '$YML' ]" "$YML missing or empty"

# 2. YAML doc marker or starts with name:
check "yaml header" "head -1 '$YML' | grep -qE '^(---|name:)'" "first line is not '---' or 'name:'"

# 3. pull_request trigger
check "on: pull_request" "grep -qE '^on:' '$YML' && grep -q 'pull_request:' '$YML'" "no 'on:' block with pull_request trigger"

# 4. paths filter src/execution/**
check "paths: src/execution/**" "grep -q 'src/execution/\*\*' '$YML'" "missing src/execution/** in paths filter"

# 5. paths filter src/capture/**
check "paths: src/capture/**" "grep -q 'src/capture/\*\*' '$YML'" "missing src/capture/** in paths filter"

# 6. concurrency block w/ cancel-in-progress: true
check "concurrency cancel-in-progress" "grep -q '^concurrency:' '$YML' && grep -q 'cancel-in-progress: true' '$YML'" "missing concurrency block or cancel-in-progress: true"

# 7. self-hosted runner (and not ubuntu-latest)
check "runs-on self-hosted" "grep -q 'runs-on: self-hosted' '$YML' && ! grep -q 'runs-on: ubuntu-latest' '$YML'" "must runs-on: self-hosted, not ubuntu-latest"

# 8. checkout@v4 with fetch-depth: 0
check "checkout@v4 fetch-depth: 0" "grep -q 'actions/checkout@v4' '$YML' && grep -q 'fetch-depth: 0' '$YML'" "missing actions/checkout@v4 or fetch-depth: 0"

# 9. baseline merge-base origin/main HEAD
check "git merge-base origin/main HEAD" "grep -q 'git merge-base origin/main HEAD' '$YML'" "missing 'git merge-base origin/main HEAD' baseline computation"

# 10. bench-local.sh --use-source
check "bench-local.sh --use-source" "grep -q 'scripts/bench-local.sh' '$YML' && grep -q -- '--use-source' '$YML'" "missing scripts/bench-local.sh invocation with --use-source"

# 11. bench-pr-comment.ts via bun or node
check "bench-pr-comment.ts invocation" "grep -qE '(bun|node) scripts/bench-pr-comment\.ts' '$YML'" "missing 'bun|node scripts/bench-pr-comment.ts'"

# 12. github-script@v7
check "actions/github-script@v7" "grep -q 'actions/github-script@v7' '$YML'" "missing actions/github-script@v7 step"

# 13. idempotency marker literal
check "<!-- bench-local-pr --> marker" "grep -qF '<!-- bench-local-pr -->' '$YML'" "missing literal '<!-- bench-local-pr -->' marker"

# 14. secret IPROYAL_URL or UNBROWSE_PROXY_URL via secrets.
check "secrets.IPROYAL_URL|UNBROWSE_PROXY_URL" "grep -qE 'secrets\.(IPROYAL_URL|UNBROWSE_PROXY_URL)' '$YML'" "no \${{ secrets.IPROYAL_URL }} or secrets.UNBROWSE_PROXY_URL reference"

# Bonus: actionlint if available
if command -v actionlint >/dev/null 2>&1; then
  if actionlint "$YML"; then
    echo "PASS: actionlint clean"
  else
    echo "FAIL: actionlint reported issues (see above)"
    FAILS=$((FAILS+1))
  fi
else
  echo "SKIP: actionlint not installed — skipped lint check"
fi

echo
echo "Summary: $PASSES passed, $FAILS failed (out of 14 required)"
[ "$FAILS" -eq 0 ]
