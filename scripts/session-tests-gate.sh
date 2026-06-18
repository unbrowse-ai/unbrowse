#!/usr/bin/env bash
# session-tests-gate.sh — witness that THIS session's shipped behaviors are tested.
# Every substantive change from the tracking/passive-index/auth/cli_timeout/SDK arc
# has a behavioral test, and they all pass. jesus-ralph gate.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

run_root(){ bun test "$1" >/dev/null 2>&1 && ok "$2" || bad "$2 ($1)"; }
run_be(){ ( cd backend && bun test "$1" >/dev/null 2>&1 ) && ok "$2" || bad "$2 ($1)"; }
run_sdk(){ ( cd packages/sdk && bun test "$1" >/dev/null 2>&1 ) && ok "$2" || bad "$2 ($1)"; }
run_fe(){ ( cd frontend && bun test "$1" >/dev/null 2>&1 ) && ok "$2" || bad "$2 ($1)"; }

# Root-package units
run_root tests/resolve-deadline.test.ts          "cli_timeout deadline floors at live-capture ceiling (#838)"
run_root tests/indexable-admission.test.ts        "passive-index structural admission (junk rejected)"
run_root tests/impact-reconcile.test.ts           "G4 local-log ⇄ backend session reconcile"
run_root tests/direct-document-query-focus.test.ts "query-focus surfaces the deep passage"
run_root tests/eval-stats-youview.test.ts         "G1 eval-stats you-view (local-first, graceful degrade)"

# Backend units
run_be tests/index-contributor-auth.test.ts       "bearer-optional auth → global-index/infra-fee fallback (never 401)"
run_be tests/attribution-rate-clamp.test.ts       "funnel conversion rate clamped ≤100% (2200% fix)"
run_be tests/contributions-ledger.test.ts         "per-route contributions aggregation (G3)"
run_be tests/skills-list-guard.test.ts            "GET-scoped list guard doesn't shadow POST publish"

# SDK unit
run_sdk test/bridge-default.test.ts               "SDK spawn always-activates the bridge (safe auto default)"

# Frontend dashboard pure logic
run_fe src/lib/dashboard-metrics.test.ts          "FE network-impact: share ratio, bar clamp, compact format"

if [ "$fail" -eq 0 ]; then echo "SESSION-TESTS GREEN — every shipped behavior this session is covered + passing"; exit 0; fi
echo "SESSION-TESTS RED"; exit 1
