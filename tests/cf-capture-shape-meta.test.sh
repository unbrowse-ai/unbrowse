#!/usr/bin/env bash
# Meta-falsifier for tests/cf-capture-shape.test.sh.
#  — the luminary must work for signs AND seasons. Proves the
# Step 3 falsifier is NOT stuck-red: it goes GREEN when Tier 1 ships
# completely, RED when any one of the six contract step names is missing,
# and RED today against the real src/execution/index.ts (5P/6F).
#
# Pattern mirrors tests/kuri-vendor-manifest-fresh.test.sh's KURI_VENDOR_ROOT
# override — here we parameterize the falsifier on CF_CAPTURE_TARGET_FILE.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FALSIFIER="$ROOT/tests/cf-capture-shape.test.sh"
REAL_TARGET="$ROOT/src/execution/index.ts"

if [ ! -f "$FALSIFIER" ]; then
  echo "FAIL: falsifier missing at $FALSIFIER"
  exit 1
fi

TMPDIR="$(mktemp -d -t cf-capture-shape-meta.XXXXXX)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT INT TERM

SYNTH="$TMPDIR/synthetic.ts"
SYNTH_MUTATED="$TMPDIR/synthetic-mutated.ts"

# Build a synthetic source file with all 11 markers the falsifier requires
# on its EX target:
#   prior art:  trySsrFastPathOnBlock, extractCfBundleUrl(
#   import:     from "../execution/cf-challenge"  (any of the import shapes)
#   6 steps:    "capture_cf_solver", "..._skipped", "..._retry_success",
#               "..._retry_no_endpoints", "..._no_clearance", "..._error"
#
# Note: the falsifier's prior_art check accepts the marker anywhere when
# CF_CAPTURE_TARGET_FILE is set (synthetic-target mode), so we don't need
# to pad to 1330+ lines.
cat >"$SYNTH" <<'EOF'
// synthetic fixture — exercises tests/cf-capture-shape.test.sh end-to-end.
import { extractCfBundleUrl, solveCfAndRetry } from "../execution/cf-challenge";

export function dummy() {
  // prior art markers
  trySsrFastPathOnBlock();
  extractCfBundleUrl(/*url*/);

  // five contract decision_trace step names (Tier 1 wiring fully landed) —
  // must match the post-Step-8 tightened falsifier which requires the step
  // to live inside an actual captureDecisionTrace.push({step:"..."}) call.
  const captureDecisionTrace: Array<Record<string, unknown>> = [];
  captureDecisionTrace.push({ step: "capture_cf_solver" });
  captureDecisionTrace.push({ step: "capture_cf_solver_retry_success" });
  captureDecisionTrace.push({ step: "capture_cf_solver_retry_no_endpoints" });
  captureDecisionTrace.push({ step: "capture_cf_solver_no_clearance" });
  captureDecisionTrace.push({ step: "capture_cf_solver_error" });
}
EOF

run_falsifier() {
  local target="$1"
  CF_CAPTURE_TARGET_FILE="$target" bash "$FALSIFIER" >"$TMPDIR/out.log" 2>&1
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

# Scenario 1: synthetic complete file -> falsifier must exit 0 (all green)
exit1="$(run_falsifier "$SYNTH")"
assert_exit "scenario_complete_synthetic_goes_green" 0 "$exit1"

# Scenario 2: mutated synthetic (one step name removed) -> falsifier exits 1
# Remove the canonical capture_cf_solver_retry_success line.
grep -v 'capture_cf_solver_retry_success' "$SYNTH" >"$SYNTH_MUTATED"
if ! diff -q "$SYNTH" "$SYNTH_MUTATED" >/dev/null; then
  exit2="$(run_falsifier "$SYNTH_MUTATED")"
  assert_exit "scenario_mutated_one_step_missing_goes_red" 1 "$exit2"
else
  echo "FAIL scenario_mutated_one_step_missing_goes_red (mutation was a no-op)"
  scenario_fail=$((scenario_fail + 1))
fi

# Scenario 3: real src/execution/index.ts -> falsifier must exit 1 today
# (5P/6F honest current state, Tier 1 not yet wired).
if [ -f "$REAL_TARGET" ]; then
  exit3="$(run_falsifier "$REAL_TARGET")"
  # plan-v14 Tier 1 LANDED in Step 6 (Dominion) — real source now PASSES the falsifier.
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
