#!/usr/bin/env bash
# proof-indexing-economy-gate.sh - witness for native proof-of-indexing/staking game theory.
# Exit 0 only when the deterministic mechanism-design tests prove the intended equilibrium:
# verified proof quality ranks first, honest indexing earns, Sybil splitting is invariant,
# stale/false proofs are slashable, false challenges are costly, and balances conserve.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
bun test tests/proof-indexing-economy.test.ts
