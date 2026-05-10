#!/usr/bin/env bash
# plan-v16-preflight.sh — gate Track A Tier work behind plan-v16 hard pre-conditions.
#
# Usage: bash scripts/plan-v16-preflight.sh
# Exits 0 only if all 6 hard checks pass. Soft checks print warnings only.
set -uo pipefail

HARD_PASS=0; HARD_FAIL=0; SOFT_PASS=0; FAILURES=()
pass() { printf '\033[32m✓\033[0m %s\n' "$1"; HARD_PASS=$((HARD_PASS+1)); }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; HARD_FAIL=$((HARD_FAIL+1)); FAILURES+=("$1"); }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
soft() { printf '\033[32m✓\033[0m %s\n' "$1"; SOFT_PASS=$((SOFT_PASS+1)); }

PIN=99c4cd30
BRANCH=feat/agent-ux-run-planner

# 1. git worktree
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  && pass "inside git worktree" \
  || fail "not inside a git worktree (cd into the repo)"

# 2. branch reachable locally or on github-ssh/origin
if git rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1 \
   || git rev-parse --verify "refs/remotes/github-ssh/$BRANCH" >/dev/null 2>&1 \
   || git rev-parse --verify "refs/remotes/origin/$BRANCH" >/dev/null 2>&1; then
  pass "branch $BRANCH reachable (local or remote)"
else
  fail "branch $BRANCH not found locally or on github-ssh/origin (run: git fetch --all)"
fi

# 3. pin commit reachable
git rev-parse --verify "${PIN}^{commit}" >/dev/null 2>&1 \
  && pass "commit $PIN reachable" \
  || fail "commit $PIN not reachable (run: git fetch --all)"

# 4. plan-v15 seed files at pin
SEEDS=(scripts/bench-pr-comment.ts tests/bench-pr-comment-shape.test.sh \
       backend/src/routes/synthetic.ts backend/src/services/freshness-probe.ts \
       backend/tests/synthetic-fixture.test.ts)
missing=()
empty=()
for f in "${SEEDS[@]}"; do
  if ! git show "${PIN}:${f}" >/dev/null 2>&1; then missing+=("$f")
  elif [ "$(git show "${PIN}:${f}" 2>/dev/null | wc -c)" -lt 100 ]; then empty+=("$f")
  fi
done
if [ ${#missing[@]} -eq 0 ] && [ ${#empty[@]} -eq 0 ]; then pass "all 5 plan-v15 seed files present + non-empty at $PIN"
elif [ ${#missing[@]} -gt 0 ]; then fail "missing seed files at $PIN: ${missing[*]}"
else fail "seed files exist but are empty/<100 bytes at $PIN: ${empty[*]}"; fi

# 5. popularity.ts (A2 freshness runtime dep)
git show "${PIN}:backend/src/services/popularity.ts" >/dev/null 2>&1 \
  && pass "backend/src/services/popularity.ts present at $PIN" \
  || fail "backend/src/services/popularity.ts missing at $PIN (A2 freshness needs it)"

# 6. bun runtime
(command -v bun >/dev/null 2>&1 && bun --version >/dev/null 2>&1) \
  && pass "bun available ($(bun --version 2>/dev/null))" \
  || fail "bun not on PATH (install: curl -fsSL https://bun.sh/install | bash)"

# Soft 7: proxy secret
if command -v gh >/dev/null 2>&1 && gh secret list 2>/dev/null | grep -qE '^(UNBROWSE_PROXY_URL|IPROYAL_URL)\b'; then
  soft "gh secret UNBROWSE_PROXY_URL/IPROYAL_URL present"
else
  warn "no UNBROWSE_PROXY_URL/IPROYAL_URL gh secret — set with: gh secret set UNBROWSE_PROXY_URL --body '<your iproyal url>'"
fi

# Soft 8: HEAD branch
HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
[ "$HEAD_BRANCH" = "$BRANCH" ] \
  && soft "on branch $BRANCH" \
  || warn "you are on $HEAD_BRANCH; run: git checkout $BRANCH"

echo
echo "plan-v16-preflight: ${HARD_PASS}/6 hard, ${SOFT_PASS}/2 soft"
[ "$HARD_FAIL" -gt 0 ] && { echo "FAILED: ${FAILURES[*]}"; exit 1; }
exit 0
