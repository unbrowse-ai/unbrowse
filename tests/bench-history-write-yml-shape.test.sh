#!/usr/bin/env bash
# Falsifier: pins structural shape of .github/workflows/bench-history-write.yml.
# Mirrors tests/bench-local-pr-yml-shape.test.sh in style.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
YML="$ROOT/.github/workflows/bench-history-write.yml"
PEER="$ROOT/.github/workflows/bench-local-pr.yml"
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

# 2. push trigger w/ branches: [main]
check "on: push branches:[main]" "grep -qE '^on:' '$YML' && grep -q 'push:' '$YML' && grep -qE 'branches:\s*\[\s*main\s*\]' '$YML'" "missing push trigger w/ branches: [main]"

# 3-6. paths-filter parity with bench-local-pr.yml
for p in "src/execution/\*\*" "src/capture/\*\*" "src/sandbox/\*\*" "src/reverse-engineer/\*\*"; do
  check "paths: $p" "grep -q '$p' '$YML' && grep -q '$p' '$PEER'" "missing $p (must mirror bench-local-pr.yml)"
done

# 7. concurrency.group: bench-history-main
check "concurrency.group bench-history-main" "grep -q '^concurrency:' '$YML' && grep -q 'group: bench-history-main' '$YML'" "missing concurrency.group: bench-history-main"

# 8. cancel-in-progress: false (NOT true — serialize, don't cancel)
check "cancel-in-progress: false" "grep -q 'cancel-in-progress: false' '$YML' && ! grep -q 'cancel-in-progress: true' '$YML'" "must be cancel-in-progress: false (serialize main pushes)"

# 9. self-hosted runner
check "runs-on self-hosted" "grep -q 'runs-on: self-hosted' '$YML' && ! grep -q 'runs-on: ubuntu-latest' '$YML'" "must runs-on: self-hosted"

# 10. permissions.contents: write
check "permissions.contents: write" "grep -qE 'permissions:' '$YML' && grep -qE 'contents:\s*write' '$YML'" "missing permissions.contents: write (needed to push back)"

# 11. checkout@v4 fetch-depth: 0
check "checkout@v4 fetch-depth: 0" "grep -q 'actions/checkout@v4' '$YML' && grep -q 'fetch-depth: 0' '$YML'" "missing actions/checkout@v4 or fetch-depth: 0"

# 12. bench-local.sh --use-source --force-capture
check "bench-local.sh --use-source --force-capture" "grep -q 'scripts/bench-local.sh' '$YML' && grep -q -- '--use-source' '$YML' && grep -q -- '--force-capture' '$YML'" "missing bench-local.sh with --use-source and --force-capture"

# 13. continue-on-error: true on bench
check "continue-on-error: true" "grep -q 'continue-on-error: true' '$YML'" "missing continue-on-error: true on bench step"

# 14. references evidence-to-history.ts
check "evidence-to-history.ts referenced" "grep -q 'evidence-to-history.ts' '$YML'" "missing reference to scripts/evidence-to-history.ts"

# 15. commit message contains [skip ci]
check "[skip ci] in commit message" "grep -qF '[skip ci]' '$YML'" "commit message must contain [skip ci] to avoid feedback loop"

# 16. UNBROWSE_PROXY_URL secret reference (parity with peer)
check "secrets.IPROYAL_URL|UNBROWSE_PROXY_URL" "grep -qE 'secrets\.(IPROYAL_URL|UNBROWSE_PROXY_URL)' '$YML'" "no IPROYAL_URL/UNBROWSE_PROXY_URL secret reference"

# Bonus: actionlint if available
if command -v actionlint >/dev/null 2>&1; then
  if actionlint "$YML"; then
    echo "PASS: actionlint clean"
  else
    echo "FAIL: actionlint reported issues"
    FAILS=$((FAILS+1))
  fi
else
  echo "SKIP: actionlint not installed"
fi

echo
echo "Summary: $PASSES passed, $FAILS failed (out of 16 required)"
[ "$FAILS" -eq 0 ]
