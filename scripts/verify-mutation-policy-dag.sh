#!/usr/bin/env bash
set -euo pipefail

bun test tests/mutation-policy.test.ts tests/run-planner.test.ts tests/dashboard-pairing.test.ts
bun test frontend/src/lib/local-runtime.test.ts
npm --prefix frontend run build >/tmp/unbrowse-mutation-policy-frontend-build.log

rg -q 'mutation_confirmation_required' src/settings.ts
rg -q 'mutation_policy' src/mcp.ts
rg -q 'MutationPolicySection' frontend/src/app/account/page.tsx
rg -q 'mutation_whitelist' frontend/src/lib/account-client.ts
rg -q 'buildDashboardPairingUrl' src/client/index.ts
rg -q 'dashboard --account' src/cli.ts
rg -q 'writeLocalRuntimeOrigin' frontend/src/app/login/page.tsx
rg -q 'unbrowse dashboard --account' frontend/src/app/account/page.tsx

echo "mutation policy DAG witness: PASS"
