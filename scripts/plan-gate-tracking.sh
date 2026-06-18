#!/usr/bin/env bash
# plan-gate-tracking.sh — witness for the "plan this out" deliverable (jesus-ralph).
#
# A plan is DONE here iff it is (a) HONEST — every "exists today" code anchor it cites
# actually grep-resolves in the tree (you cannot fake-green this without the code being
# real) — and (b) COMPLETE — every build node in the spine names a runnable witness
# command. This is the non-fake gate for a planning deliverable: it grounds the plan in
# the real codebase and forces every future node to carry its own falsifiable witness.
#
# Exit 0 ⇔ the plan is honest + complete. This does NOT assert the FEATURE is built —
# that is sealed later by scripts/tracking-gate.sh (named inside the plan), one node at a time.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
PLAN="docs/plans/tracking-contributions-payouts-savings.md"
fail=0
note(){ printf '%s %s\n' "$1" "$2"; }

[ -f "$PLAN" ] || { note "FAIL" "plan file missing: $PLAN"; exit 1; }
note "OK" "plan present: $PLAN"

# (a) HONEST — every cited anchor must resolve to real code.
anchor(){ # name  test-expr
  if eval "$2" >/dev/null 2>&1; then note "OK" "anchor:$1 resolves"; else note "FAIL" "anchor:$1 does NOT resolve"; fail=1; fi
}
anchor impact-compute      "git grep -l 'cost_saved_uc' -- src/orchestrator/timing-economics.ts"
anchor impact-log          "git grep -l 'appendImpact' -- src/impact-log.ts"
anchor contribution-config "git grep -l 'wallet_address' -- src/config/contribution.ts"
anchor dashboard-route     "git grep -nE '/dashboard/me|/dashboard/wallet' -- backend/src/routes/dashboard.ts"
anchor analytics-economics "git grep -nE '/economics|/network' -- backend/src/routes/analytics.ts"
anchor analytics-sessions  "git grep -n 'sessions' -- backend/src/routes/analytics.ts"
anchor flex-split          "git grep -lE 'BPS' -- backend/src/services/flex.ts"
anchor settlement          "git grep -l 'earningsForWallet' -- backend/src/services/settlement.ts"
anchor frontend-dashboard  "test -f frontend/src/components/contributor-dashboard.tsx"
anchor cli-earnings-shim   "test -f src/cli-v7/eval/earnings.ts"

# (b) COMPLETE — every build/eval node in the spine must name a witness. We require the
# four node ids and that each has a runnable witness token (jq -e, bun test, or a gate).
for n in G1 G2 G3 G4; do
  row="$(grep -nE "^\| \[.\] \| $n " "$PLAN" || true)"
  if [ -z "$row" ]; then note "FAIL" "node $n missing from spine table"; fail=1; continue; fi
  if printf '%s' "$row" | grep -qE 'jq -e|bun test|scripts/'; then
    note "OK" "node $n names a witness"
  else
    note "FAIL" "node $n has no runnable witness"; fail=1
  fi
done

# The seal witness must be named so a future build loop has a single whole-goal gate.
grep -q 'scripts/tracking-gate.sh' "$PLAN" && note "OK" "seal witness named (scripts/tracking-gate.sh)" \
  || { note "FAIL" "no seal witness named"; fail=1; }

if [ "$fail" -eq 0 ]; then note "PASS" "plan is honest + complete"; exit 0; else note "FAIL" "plan gate failed"; exit 1; fi
