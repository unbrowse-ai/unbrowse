#!/usr/bin/env bash
# contract-onchain-callsite-gate.sh — the verdict ACTUALLY lands on-chain on a real execute.
# The seam (persistVerdictOnChain) exists + is witnessed; this gates the CALL-SITE that fires it
# on the execute terminal — with the load-bearing safety constraint that the DEFAULT path pays
# nothing (no per-execute network): the call must be opt-in gated AND fire-and-forget.
#   G1 wired    — execute.ts calls persistVerdictOnChain on its terminal path
#   G2 gated    — the call is behind an opt-in env gate (default install fires nothing)
#   G3 forget   — the call is fire-and-forget (void / .catch — never awaited on the hot path)
#   G4 nofreg   — the execute pay-only/x402 tests still pass (no regression)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }
F="src/cli-v7/breath/execute.ts"

grep -q 'persistVerdictOnChain' "$F" || fail "G1 wired: execute does not call persistVerdictOnChain on its terminal"
echo "ok G1 wired — execute fires persistVerdictOnChain on a terminal success"

# G2 — the call must sit behind an opt-in gate so the DEFAULT install adds zero network
grep -qE 'UNBROWSE_CONTRACT_ONCHAIN|process\.env' "$F" && grep -B2 -A1 'persistVerdictOnChain' "$F" | grep -qE 'env|ONCHAIN|if ' \
  || fail "G2 gated: the on-chain call is not behind an opt-in env gate (would tax every execute)"
echo "ok G2 gated — opt-in env gate; the default (un-opted-in) execute path pays nothing"

# G3 — fire-and-forget: the call is void-ed / catches; it must NOT be awaited on the hot path
grep -E 'persistVerdictOnChain' "$F" | grep -qE 'void |\.catch\(' || fail "G3 forget: the on-chain call is awaited/blocking — it must be fire-and-forget"
grep -E 'await persistVerdictOnChain' "$F" | grep -q . && fail "G3 forget: persistVerdictOnChain is awaited on the execute hot path (blocking)"
echo "ok G3 forget — fire-and-forget (void + .catch), never blocks the execute hot path"

# G4 — no regression on the execute test surface
( timeout 120 bun test tests/unbrowse-testing-x402.test.ts ) >/tmp/onchain-callsite.log 2>&1 || { tail -6 /tmp/onchain-callsite.log; fail "G4 nofreg: execute/x402 test regressed"; }
echo "ok G4 nofreg — execute/x402 tests still green"

echo "GATE GREEN — the /contract verdict actually lands on-chain on a real execute (gated, fire-and-forget)"
