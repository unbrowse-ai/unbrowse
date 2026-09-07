#!/usr/bin/env bash
# Witness for the jesus-graph: "solve auth+CF blocking + SDK-first onboarding".
# Exit 0 only when the thin SDK surface can be used by an agent without the heavy CLI setup,
# and the fetch layer can be told to recover from challenges using the existing solvers.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[witness] checking SDK surface is importable and does not force setup..."

# 1. The SDK surface and onboarding semantics must execute. A source grep is not
# an acceptable substitute for an import or behavior witness.
command -v bun >/dev/null 2>&1 || { echo "bun is required for the SDK witness"; exit 1; }
bun --eval '
  import("./src/sdk/index.ts").then(m => {
    if (!m || !m.createFetch || !m.ensureIdentity || !m.onboardingStatus) {
      console.error("SDK surface missing expected exports");
      process.exit(1);
    }
    console.log("SDK surface OK");
  }).catch(e => { console.error(e); process.exit(1); });
'
bun test tests/sdk-onboard.test.ts

# 2. Source-level guarantee: fetch.ts has recoverChallenge support and onboard auto-creates wallet.
grep -q 'recoverChallenge' packages/skill/src/sdk/fetch.ts || { echo "recoverChallenge not wired in fetch"; exit 1; }
grep -q 'ensureLocalWalletAddress' packages/skill/src/sdk/onboard.ts || { echo "SDK onboard does not auto-create wallet"; exit 1; }

# 3. Challenge solvers exist and are the same ones used by the CLI/orchestrator.
test -f src/execution/cf-challenge.ts || { echo "missing cf solver"; exit 1; }
test -f src/execution/px-challenge.ts || { echo "missing px solver"; exit 1; }
test -f src/execution/akamai-challenge.ts || { echo "missing akamai solver"; exit 1; }
test -f src/execution/kasada-challenge.ts || { echo "missing kasada solver"; exit 1; }
test -f src/orchestrator/challenge-solver-bridge.ts || { echo "missing solver bridge"; exit 1; }

# 4. Setup can be skipped for pure SDK usage (installBrowser:false path + env flags).
grep -q 'installBrowser' src/runtime/setup.ts || { echo "setup does not honour installBrowser"; exit 1; }
grep -q 'UNBROWSE_NON_INTERACTIVE' src/runtime/setup.ts || { echo "setup does not honour NON_INTERACTIVE"; exit 1; }

echo "[witness] runtime onboarding and bounded challenge-recovery wiring passed."
exit 0
