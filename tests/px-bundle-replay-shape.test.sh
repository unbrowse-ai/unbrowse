#!/usr/bin/env bash
# Falsifier seed for plan-v13 Tier 2B (PerimeterX bundle-replay solver).
# Mirrors tests/cf-capture-shape.test.sh (Step 8 sub-agent J's tightened regex).
# Today's expected state (Day 3 Land, before Step 6 wiring):
#   PASS: platform (px-challenge.ts file + 2 exports), CF prior art reference.
#   FAIL: executor import + 8 decision_trace step names (Step 6 wires these).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PX="$ROOT/src/execution/px-challenge.ts"
EX="${PX_TARGET_FILE:-$ROOT/src/execution/index.ts}"
FAILED=0

pass() { printf "PASS %s\n" "$1"; }
fail() { printf "FAIL %s — %s\n" "$1" "$2"; FAILED=1; }

# --- 1. platform (expected PASS today) ---
if [ -f "$PX" ]; then
  pass "px_challenge_file_exists"
else
  fail "px_challenge_file_exists" "$PX missing"
  exit 1
fi

if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+extractPxBundleUrl\b' "$PX"; then
  pass "exports_extractPxBundleUrl"
else
  fail "exports_extractPxBundleUrl" "no 'export function extractPxBundleUrl' in $PX"
fi

if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+solvePxAndRetry\b' "$PX"; then
  pass "exports_solvePxAndRetry"
else
  fail "exports_solvePxAndRetry" "no 'export function solvePxAndRetry' in $PX"
fi

# --- 2a. Prior art: CF vendor arm pins where PX arm should sit nearby ---
if grep -qE 'vendor[[:space:]]*===[[:space:]]*"cloudflare"' "$EX"; then
  pass "prior_art_cf_vendor_arm"
else
  fail "prior_art_cf_vendor_arm" \
    "expected vendor === \"cloudflare\" arm in $EX (PX arm sits adjacent)"
fi

# --- 2b. Tier 2B wiring: solvePxAndRetry called in executor (expected PASS post-Step-6) ---
# Mirrors CF wiring pattern — executor calls solvePxAndRetry, which itself uses extractPxBundleUrl internally.
if grep -q 'solvePxAndRetry' "$EX"; then
  pass "executor_imports_px_challenge"
else
  fail "executor_imports_px_challenge" \
    "Tier 2B not wired: no solvePxAndRetry call in $EX"
fi

# --- 3. Decision-trace step names (expected FAIL today; PASS after Step 6) ---
# plan-v13 Tier 2B contract: 8 step names emitted from the PX solver branch.
# Tightened per Step 8 auditor J: must appear inside a real
# decisionTrace.push({step:"..."}) call, not just any string in the file.
# Mirroring CF Step 9 rest prune: internal solver sub-states
# (_skipped, _bundle_fetch_failed, _no_cookies_armed) are intentionally
# folded into _retry_still_blocked at the call site, not emitted separately.
# Falsifier pins the 5 step names that ACTUALLY emit at the call site.
STEPS=(
  vendor_blocked_px_solver
  vendor_blocked_px_solver_retry_success
  vendor_blocked_px_solver_retry_extract_empty
  vendor_blocked_px_solver_retry_still_blocked
  vendor_blocked_px_solver_error
)
for s in "${STEPS[@]}"; do
  if grep -qE 'decisionTrace\.push\([^)]*step:[[:space:]]*"'"$s"'"' "$EX" \
     || grep -qE "decisionTrace\.push\([^)]*step:[[:space:]]*'$s'" "$EX"; then
    pass "decision_trace_step:$s"
  else
    fail "decision_trace_step:$s" "no decisionTrace.push({step:\"$s\"}) call in $EX"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  printf "\nFAILED — falsifier is firing as expected until Tier 2B (Step 6) wires the PX solver\n"
  exit 1
fi
printf "\nALL PASS\n"
exit 0
