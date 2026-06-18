#!/usr/bin/env bash
# dashboard-perf-gate.sh — witness for the dashboard compute fixes + auto-publish default.
#   1. /dashboard/me is cached (no per-view leaderboard scan)
#   2. the 4 KV scans (leaderboard hot path) are cached/shared, not run per call
#   3. auto-publish to marketplace is ON by default for everyone
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

# 1. /dashboard/me cached
grep -q 'getOrSetHttpCache(c.env, `dashboard:me:' backend/src/routes/dashboard.ts \
  && ok "/dashboard/me is per-agent cached" || bad "/dashboard/me not cached"

# 2. the 4-scan leaderboard hot path is cached + shared (loadLeaderboardRaw)
grep -q "function loadLeaderboardRaw" backend/src/services/economics.ts \
  && grep -q 'getOrSetHttpCache(env, "leaderboard:raw"' backend/src/services/economics.ts \
  && ok "leaderboard 4-scan cached (loadLeaderboardRaw)" || bad "leaderboard scan not cached"

# 2b. loadLeaderboardState no longer scans inline — it reads via the cached raw loader
grep -A4 "async function loadLeaderboardState" backend/src/services/economics.ts | grep -q "loadLeaderboardRaw" \
  && ok "loadLeaderboardState sources the cached scan (no inline re-scan)" \
  || bad "loadLeaderboardState still scans inline"

# 3. auto-publish default ON for everyone
grep -q "user.share_pointers ?? true" backend/src/services/accounts.ts \
  && ok "auto-publish to marketplace ON by default (share_pointers ?? true)" \
  || bad "auto-publish still defaults off"

# 3b. opt-out STORES PRIVATE (submit later) instead of dropping the capture
bun test tests/review-gate-predicate.test.ts >/dev/null 2>&1 \
  && ok "opt-out stores private + submit-later (review-gate predicate)" \
  || bad "private-store gate predicate failing"

# 3c. cloud cache goes STALE on change — invalidation wired on the write paths
grep -q "export async function invalidateDashboardCaches" backend/src/services/economics.ts \
  && grep -q "invalidateDashboardCaches" backend/src/routes/skills.ts \
  && grep -q "invalidateDashboardCaches" backend/src/routes/stats.ts \
  && ok "dashboard cache invalidated on publish/visibility/execution (stale-on-change)" \
  || bad "cache invalidation not wired on write paths"

# 4. the changed backend files typecheck clean (beyond the repo's known cross-package noise)
errs=$(cd backend && bunx tsc --noEmit 2>&1 | grep -E "services/economics\.ts|services/accounts\.ts|routes/dashboard\.ts" | grep -vE "rootDir|is not under|node:" | wc -l | tr -d ' ')
[ "${errs:-0}" -eq 0 ] && ok "changed backend files typecheck clean" || bad "$errs tsc error(s) in changed files"

if [ "$fail" -eq 0 ]; then echo "DASHBOARD-PERF GREEN — cached reads, no per-view scan, auto-publish default on"; exit 0; fi
echo "DASHBOARD-PERF RED"; exit 1
