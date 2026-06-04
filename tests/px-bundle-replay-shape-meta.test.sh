#!/usr/bin/env bash
# Meta-falsifier for tests/px-bundle-replay-shape.test.sh.
#  — luminaries work for signs AND seasons. Proves the Step 3
# falsifier is NOT stuck-red: it goes GREEN when Tier 2B Step 6 wires all 8
# step names, RED when any one is missing, and RED today against the real
# src/execution/index.ts (4P/9F).
#
# Mirrors tests/cf-capture-shape-meta.test.sh — parameterizes the falsifier
# on PX_TARGET_FILE.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FALSIFIER="$ROOT/tests/px-bundle-replay-shape.test.sh"
REAL_TARGET="$ROOT/src/execution/index.ts"

if [ ! -f "$FALSIFIER" ]; then
  echo "FAIL: falsifier missing at $FALSIFIER"
  exit 1
fi

TMPDIR="$(mktemp -d -t px-bundle-replay-shape-meta.XXXXXX)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT INT TERM

SYNTH="$TMPDIR/synthetic.ts"
SYNTH_MUTATED="$TMPDIR/synthetic-mutated.ts"

# Build a synthetic source file with all markers the falsifier requires on
# its EX target:
#   prior art:  vendor === "cloudflare"
#   import:     extractPxBundleUrl( call site
#   8 steps:    vendor_blocked_px_solver{,_skipped,_bundle_fetch_failed,
#               _no_cookies_armed,_retry_success,_retry_extract_empty,
#               _retry_still_blocked,_error}
#
# Each step must live inside a real decisionTrace.push({step:"..."}) call,
# matching the Step 8 tightened regex.
cat >"$SYNTH" <<'EOF'
// synthetic fixture — exercises tests/px-bundle-replay-shape.test.sh end-to-end.
import { extractPxBundleUrl, solvePxAndRetry } from "./px-challenge.js";

export function dummy() {
  // prior art marker — CF vendor arm pins where PX arm should sit nearby.
  if (vendor === "cloudflare") {
    /* CF arm */
  }

  // PX solver call site (Tier 2B Step 6 wiring).
  const bundleUrl = extractPxBundleUrl(/*url*/);

  // 8 contract decision_trace step names — must live inside a real
  // decisionTrace.push({step:"..."}) call per the Step 8 tightened regex.
  const decisionTrace: Array<Record<string, unknown>> = [];
  // 5 contract steps emitted at call site (3 internal solver states folded into _retry_still_blocked, post-Step-9 rest prune).
  decisionTrace.push({ step: "vendor_blocked_px_solver" });
  decisionTrace.push({ step: "vendor_blocked_px_solver_retry_success" });
  decisionTrace.push({ step: "vendor_blocked_px_solver_retry_extract_empty" });
  decisionTrace.push({ step: "vendor_blocked_px_solver_retry_still_blocked" });
  decisionTrace.push({ step: "vendor_blocked_px_solver_error" });
}
EOF

run_falsifier() {
  local target="$1"
  PX_TARGET_FILE="$target" bash "$FALSIFIER" >"$TMPDIR/out.log" 2>&1
  echo $?
}

scenario_pass=0
scenario_fail=0

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS $label (exit=$actual)"
    scenario_pass=$((scenario_pass + 1))
  else
    echo "FAIL $label (expected exit=$expected, got=$actual)"
    echo "----- falsifier output -----"
    cat "$TMPDIR/out.log"
    echo "----------------------------"
    scenario_fail=$((scenario_fail + 1))
  fi
}

# Scenario 1: synthetic complete file -> falsifier exits 0 (all green).
exit1="$(run_falsifier "$SYNTH")"
assert_exit "scenario_complete_synthetic_goes_green" 0 "$exit1"

# Scenario 2: mutated synthetic (one step name removed) -> falsifier exits 1.
grep -v 'vendor_blocked_px_solver_retry_success' "$SYNTH" >"$SYNTH_MUTATED"
if ! diff -q "$SYNTH" "$SYNTH_MUTATED" >/dev/null; then
  exit2="$(run_falsifier "$SYNTH_MUTATED")"
  assert_exit "scenario_mutated_one_step_missing_goes_red" 1 "$exit2"
else
  echo "FAIL scenario_mutated_one_step_missing_goes_red (mutation was a no-op)"
  scenario_fail=$((scenario_fail + 1))
fi

# Scenario 3: real src/execution/index.ts -> falsifier exits 1 today
# (4P/9F honest current state, Tier 2B Step 6 not yet wired).
if [ -f "$REAL_TARGET" ]; then
  exit3="$(run_falsifier "$REAL_TARGET")"
  # plan-v13 Tier 2B LANDED in Step 6 (Dominion) — real source now PASSES the falsifier.
  assert_exit "scenario_real_executor_today_green" 0 "$exit3"
else
  echo "FAIL scenario_real_executor_today_red (target missing: $REAL_TARGET)"
  scenario_fail=$((scenario_fail + 1))
fi

echo
echo "---"
echo "scenarios passed: $scenario_pass   failed: $scenario_fail"
if [ "$scenario_fail" -gt 0 ]; then
  exit 1
fi
exit 0
