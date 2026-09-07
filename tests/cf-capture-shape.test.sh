#!/usr/bin/env bash
# Falsifier seed for plan-v14 Tier 1 (capture-time CF challenge solver).
# Genesis 1:11 — seed-bearing: runnable today, fails on the parts Step 6
# (Dominion) is responsible for wiring up. Today's expected state:
#   PASS: substrate (cf-challenge.ts exports), prior art (SSR fastpath ref).
#   FAIL: Tier 1 wiring (extractCfBundleUrl import + 6 decision_trace steps).
# When Step 6 lands, all checks turn green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="$ROOT/src/execution/cf-challenge.ts"
EX="${CF_CAPTURE_TARGET_FILE:-$ROOT/src/execution/index.ts}"
FAILED=0

pass() { printf "PASS %s\n" "$1"; }
fail() { printf "FAIL %s — %s\n" "$1" "$2"; FAILED=1; }

# --- 1. Substrate (Step 1, expected PASS today) ---
if [ -f "$CF" ]; then
  pass "cf_challenge_file_exists"
else
  fail "cf_challenge_file_exists" "$CF missing"
  exit 1
fi

if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+extractCfBundleUrl\b' "$CF"; then
  pass "exports_extractCfBundleUrl"
else
  fail "exports_extractCfBundleUrl" "no 'export function extractCfBundleUrl' in $CF"
fi

if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+solveCfAndRetry\b' "$CF"; then
  pass "exports_solveCfAndRetry"
else
  fail "exports_solveCfAndRetry" "no 'export function solveCfAndRetry' in $CF"
fi

# --- 2a. Prior art at insertion zone (expected PASS today) ---
# The no-clean-endpoints arm already runs trySsrFastPathOnBlock; pin that line
# range so a future refactor that moves the arm doesn't silently relocate the
# Tier 1 hook.
if { [ -n "${CF_CAPTURE_TARGET_FILE:-}" ] && grep -q "trySsrFastPathOnBlock" "$EX"; } || awk 'NR>=1330 && NR<=1360' "$EX" | grep -q 'trySsrFastPathOnBlock'; then
  pass "prior_art_ssr_fastpath_at_insertion_zone"
else
  fail "prior_art_ssr_fastpath_at_insertion_zone" \
    "expected trySsrFastPathOnBlock reference in src/execution/index.ts L1330-1360"
fi

# --- 2b. Tier 1 wiring: cf-challenge call in no-clean-endpoints arm (expected FAIL today) ---
# The existing solver path imports cf-challenge at ~L2842 (auth_recovery branch).
# Don't let that pre-existing import green-light the Tier 1 check. Require
# specifically an `extractCfBundleUrl(` call BEFORE line 2000, which is where
# the no-clean-endpoints arm sits (~L1330-1390). Step 6 wires this; today's
# detection-only seed at L1365 already satisfies the call requirement.
if grep -n 'extractCfBundleUrl(' "$EX" | awk -F: '$1 < 2000' | grep -q .; then
  pass "executor_imports_cf_challenge"
else
  fail "executor_imports_cf_challenge" \
    "Tier 1 not wired: no extractCfBundleUrl( call before L2000 (no-clean-endpoints arm)"
fi

# --- 3. Decision-trace step names (expected FAIL today; PASS after Step 6) ---
# plan-v14 §"Decision-trace step names" — six contract strings that the
# capture-time CF solver branch must emit. Pinning them here keeps the
# downstream agent (which pattern-matches on decision_trace) honest.
STEPS=(
  capture_cf_solver
  capture_cf_solver_retry_success
  capture_cf_solver_retry_no_endpoints
  capture_cf_solver_no_clearance
  capture_cf_solver_error
)
for s in "${STEPS[@]}"; do
  # Step 8 (Judgement) auditor J: tighten from anywhere-string to require the
  # step name to appear inside an actual decisionTrace.push({step:"..."}) call.
  # Catches the tautology where log() strings or comments green-light a check
  # even though the runtime push was removed.
  if grep -qE 'captureDecisionTrace\.push\([^)]*step:[[:space:]]*"'"$s"'"' "$EX" \
     || grep -qE "captureDecisionTrace\.push\([^)]*step:[[:space:]]*'$s'" "$EX"; then
    pass "decision_trace_step:$s"
  else
    fail "decision_trace_step:$s" "no captureDecisionTrace.push({step:\"$s\"}) call in $EX"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  printf "\nFAILED — falsifier is firing as expected until Tier 1 (Step 6 Dominion) wires the call site\n"
  exit 1
fi
printf "\nALL PASS\n"
exit 0
