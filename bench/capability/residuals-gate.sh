#!/usr/bin/env bash
# residuals-gate: the runnable witness for the de-hatching directive. Exits 0 ONLY when every escape
# hatch is gone — the cascade is safe ON by default, the deferred residuals are solved, and the
# dormant stubs are deleted. This gate is the loop's only exit (no park/break/promise soft-out).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
fail=0
say() { printf '%-58s %s\n' "$1" "$2"; }

# 1) all capability witnesses green (incl. cookie-principal, yield-safety, multi-step walk e2e)
for t in test_value_set_pointer test_composite_cascade_invalidation test_value_ledger_dependency_cascade \
         test_dag_hole_binding_cascade test_persistent_cascade_walk test_param_leak_characterization \
         test_param_leak_guard test_yield_safety test_cookie_principal test_walk_persist_replay_e2e; do
  if timeout 90 bun "bench/capability/$t.ts" >/dev/null 2>&1; then say "witness $t" "PASS"; else say "witness $t" "FAIL"; fail=1; fi
done

# 2) cascade is ON by default — no UNBROWSE_LOCAL_CACHES opt-in escape hatch on prereqCacheTtlMs
ttlfn=$(awk '/function prereqCacheTtlMs/,/^}/' src/orchestrator/index.ts)
if grep -q "UNBROWSE_LOCAL_CACHES" <<<"$ttlfn"; then say "no opt-in escape hatch on the cascade" "FAIL"; fail=1; else say "no opt-in escape hatch on the cascade" "PASS"; fi

# 3) cookie-principal closed — the walk folds cookies into the principal
if git grep -q "credentialFromAuthContext(authHeaders, prereqCookies)" -- src/orchestrator/index.ts; then say "cookie-principal folded in the walk" "PASS"; else say "cookie-principal folded in the walk" "FAIL"; fail=1; fi

# 4) dormant stubs DELETED (no dormant-by-design)
for f in src/values/resolution-tier.ts src/trust/descent-cache.ts src/orchestrator/browser-agent.ts; do
  if [ -e "$f" ]; then say "deleted dormant stub $(basename "$f")" "FAIL"; fail=1; else say "deleted dormant stub $(basename "$f")" "PASS"; fi
done

[ "$fail" = 0 ] && echo "RESIDUALS-GATE: PASS" || echo "RESIDUALS-GATE: FAIL"
exit "$fail"
