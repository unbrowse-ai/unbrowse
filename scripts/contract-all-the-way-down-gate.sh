#!/usr/bin/env bash
# contract-all-the-way-down-gate.sh — "make it always do that": every primitive act carries
# the /contract three-shape verdict (interpret→verify→adjudicate) as `_contract`, so a routing
# OR execution decision is never an opaque payload — it is an adjudicated contract. Reddens the
# moment a primitive drops the verdict (the "always" is mechanical, not a promise).
#   G1 resolve  — the resolve hot path emits _contract (already shipped)
#   G2 execute  — the execute act emits _contract (this wave)
#   G3 always   — the verdict is UNCONDITIONAL on both paths (no flag/env gate)
#   G4 witness  — the shared bridge adjudicates a real result + names the frontier on a miss
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }

grep -q '_contract: contractVerdict' src/cli-v7/eval/resolve.ts || fail "G1 resolve: resolve path no longer emits _contract"
echo "ok G1 resolve — resolve emits the three-shape _contract verdict"

grep -q '_contract: executeVerdict' src/cli-v7/breath/execute.ts || fail "G2 execute: execute act no longer emits _contract"
echo "ok G2 execute — execute emits the three-shape _contract verdict"

# G3 — unconditional: the verdict call must not sit behind an env/flag gate on either path
if grep -nE 'process\.env.*CONTRACT|if \([^)]*contract[^)]*enabled' src/cli-v7/eval/resolve.ts src/cli-v7/breath/execute.ts 2>/dev/null | grep -q .; then
  fail "G3 always: a flag/env gate appeared around the contract verdict — it must be unconditional"
fi
echo "ok G3 always — the verdict is unconditional (no opt-in flag), it always fires"

# G4 — behavioural: the shared bridge is terminal on a real result, frontier-named on a miss
bun -e '
import { resolutionContractVerdict } from "./src/values/resolution-contract.ts";
const ok = await resolutionContractVerdict({ intent: "e", skill: { skill_id: "e", endpoints: [{ status: 200 }] } });
const bad = await resolutionContractVerdict({ intent: "e", skill: { skill_id: "e", endpoints: [] } });
if (!ok.terminal || bad.terminal || bad.frontier !== "adjudicate") process.exit(1);
' >/dev/null 2>&1 || fail "G4 witness: the shared verdict bridge regressed"
echo "ok G4 witness — verdict is terminal on a real result, names the frontier on a miss"

echo "GATE GREEN — /contract all the way down: resolve + execute both always carry the three-shape verdict"
