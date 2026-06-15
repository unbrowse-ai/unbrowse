#!/usr/bin/env bash
# stable-release-gate — prove `main` is a stable release before it syncs public.
#
# The seal node (CLAUDE.md S8): no fabricated green. Exit 0 means the public
# stable surface is verified AND the moat boundary holds — safe to be the stable
# release that syncs to the public repo. The advanced reveals (zk auth, the
# maintenance network) live on their own branches with their own gates; this gate
# proves only what ships publicly today: the drop-in-replacement wedge.
#
# Usage: bash scripts/stable-release-gate.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
section() { printf '\n=== %s ===\n' "$1"; }

# 1. Stable public surface — the drop-in-replacement wedge (Paper 1): covenant
#    primitive, x402 payment rail, resolve, ranking, the interop drop-in
#    (skills/MCP/x402-Bazaar), the publish gate. Curated + deterministic (no
#    network-coupled or batch-flaky files).
section "stable-surface tests"
STABLE_TESTS=(
  tests/covenant-seed.test.ts
  tests/covenant-toll-ledger.test.ts
  tests/mcp-x402.test.ts
  tests/x402-payment-lane.test.ts
  tests/x402-lobster-pay.test.ts
  tests/payment-gate.test.ts
  tests/execution-payment-surface.test.ts
  tests/client-search-x402.test.ts
  tests/orchestrator-search-x402.test.ts
  tests/composite-scoring.test.ts
  tests/publish-validation.test.ts
  tests/agent-primitives.test.ts
  tests/interop-discover.test.ts
  tests/interop-sources.test.ts
)
if bun test "${STABLE_TESTS[@]}"; then
  echo "stable-surface tests: PASS"
else
  echo "stable-surface tests: FAIL"; fail=1
fi

# 2. Moat boundary — THE gate for public sync. No economic constant, capture/RE
#    engine internal, or operator surface may cross into a public artifact.
section "leak-guard (moat boundary)"
if bash scripts/leak-guard.sh >/dev/null 2>&1; then
  echo "leak-guard: PASS"
else
  echo "leak-guard: FAIL"; fail=1
fi

# 3. Papers reflect code — no overclaim in the public papers.
section "paper-gate (papers reflect code)"
for tex in paper/crypto-was-all-you-needed.tex paper/internal-apis-were-not-all-you-needed.tex; do
  if bash scripts/paper-gate.sh "$tex" >/dev/null 2>&1; then
    echo "paper-gate $tex: PASS"
  else
    echo "paper-gate $tex: FAIL"; fail=1
  fi
done

section "verdict"
if [ "$fail" -eq 0 ]; then
  echo "STABLE-GATE PASS — public stable surface verified, moat boundary holds."
else
  echo "STABLE-GATE FAIL — not safe to sync to the public stable release."
fi
exit "$fail"
