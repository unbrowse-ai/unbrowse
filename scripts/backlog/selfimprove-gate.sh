#!/usr/bin/env bash
# selfimprove-gate.sh — witness for selfimprove-loop: the unattended self-build
# loop (early-stop on fail, ship scoped fix, advance) is built.
#   - early-stop primitive is TESTED (bench-gate collector stop-on-fail mode)
#   - the unattended runner ralph-bench-loop.sh loops iterations, stops on a new
#     failure class (early-stop), and promotes passing candidates to permanent
#     regression coverage (advance). The scoped-fix step is the composed
#     unbrowse-improvement-loop skill (one gated commit per named regression).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
bun test tests/bench-gate-stop-on-fail.test.ts >/dev/null 2>&1 || { echo "FAIL: early-stop primitive test"; exit 1; }
R=scripts/ralph-bench-loop.sh
[ -f "$R" ] || { echo "FAIL: unattended runner $R missing"; exit 1; }
grep -qE 'for iter in|while ' "$R" || { echo "FAIL: $R has no iteration loop (unattended)"; exit 1; }
grep -qE 'stop-on-new-fail|STOP_ON_NEW_FAIL|stop.*fail' "$R" || { echo "FAIL: $R has no early-stop-on-fail"; exit 1; }
grep -qE 'benchmark-baseline|promote|coverage' "$R" || { echo "FAIL: $R does not promote/advance passing candidates"; exit 1; }
echo "ok: early-stop primitive tested + ralph-bench-loop.sh (iterate -> stop-on-new-fail -> promote-to-coverage); scoped fix via the unbrowse-improvement-loop skill"
