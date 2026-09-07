#!/usr/bin/env bash
# Falsifier seed for plan-v13 Tier 2C (Akamai bundle-replay solver).
# Mirrors tests/px-bundle-replay-shape.test.sh (Step 8 sub-agent J's tightened regex).
# Today's expected state (before Step 6 wiring):
#   PASS: substrate (akamai-challenge.ts file + 2 exports), CF prior art reference.
#   FAIL: executor import + 5 decision_trace step names (Step 6 wires these).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AK="$ROOT/src/execution/akamai-challenge.ts"
EX="${AKAMAI_TARGET_FILE:-$ROOT/src/execution/index.ts}"
FAILED=0

pass() { printf "PASS %s\n" "$1"; }
fail() { printf "FAIL %s — %s\n" "$1" "$2"; FAILED=1; }

# --- 1. Substrate (expected PASS today) ---
if [ -f "$AK" ]; then
  pass "akamai_challenge_file_exists"
else
  fail "akamai_challenge_file_exists" "$AK missing"
  exit 1
fi

if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+extractAkamaiBundleUrl\b' "$AK"; then
  pass "exports_extractAkamaiBundleUrl"
else
  fail "exports_extractAkamaiBundleUrl" "no 'export function extractAkamaiBundleUrl' in $AK"
fi

if grep -qE '^export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+solveAkamaiAndRetry\b' "$AK"; then
  pass "exports_solveAkamaiAndRetry"
else
  fail "exports_solveAkamaiAndRetry" "no 'export function solveAkamaiAndRetry' in $AK"
fi

# --- 2a. Prior art: CF vendor arm pins where Akamai arm should sit nearby ---
if grep -qE 'vendor[[:space:]]*===[[:space:]]*"cloudflare"' "$EX"; then
  pass "prior_art_cf_vendor_arm"
else
  fail "prior_art_cf_vendor_arm" \
    "expected vendor === \"cloudflare\" arm in $EX (Akamai arm sits adjacent)"
fi

# --- 2b. Tier 2C wiring: solveAkamaiAndRetry called in executor (expected PASS post-Step-6) ---
# Mirrors CF/PX wiring pattern — executor calls solveAkamaiAndRetry, which itself uses extractAkamaiBundleUrl internally.
# Step 8 audit fix: require dynamic-import call form, not just substring (would false-pass on comments)
if grep -qE 'await import\("\./akamai-challenge\.js"\)' "$EX" && grep -qE 'await solveAkamaiAndRetry\(' "$EX"; then
  pass "executor_imports_akamai_challenge"
else
  fail "executor_imports_akamai_challenge" \
    "Tier 2C not wired: missing 'await import(\"./akamai-challenge.js\")' OR 'await solveAkamaiAndRetry(' in $EX"
fi

# --- 3. Decision-trace step names (expected FAIL today; PASS after Step 6) ---
# plan-v13 Tier 2C contract: 5 step names emitted from the Akamai solver branch.
# Tightened per Step 8 auditor J: must appear inside a real
# decisionTrace.push({step:"..."}) call, not just any string in the file.
# Mirroring CF Step 9 sabbath prune: internal solver sub-states
# (_skipped, _bundle_fetch_failed, _no_cookies_armed) are intentionally
# folded into _retry_still_blocked at the call site, not emitted separately.
# Falsifier pins the 5 step names that ACTUALLY emit at the call site.
STEPS=(
  vendor_blocked_akamai_solver
  vendor_blocked_akamai_solver_retry_success
  vendor_blocked_akamai_solver_retry_extract_empty
  vendor_blocked_akamai_solver_retry_still_blocked
  vendor_blocked_akamai_solver_error
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
  printf "\nFAILED — falsifier is firing as expected until Tier 2C (Step 6) wires the Akamai solver\n"
  exit 1
fi
printf "\nALL PASS\n"
exit 0
