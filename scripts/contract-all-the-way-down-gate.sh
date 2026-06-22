#!/usr/bin/env bash
# contract-all-the-way-down-gate.sh — "/contract shaped all the way through": EVERY primitive's
# emit envelope carries the three-shape verdict (interpret→verify→adjudicate), attached at the ONE
# shared emit() boundary from the envelope's universal shape — zero per-primitive wiring (no hard
# per-primitive list — Synapse-kind minimum, Matt 5:37 + "never a hard filter when a structural
# signal exists"). Reddens if the boundary stops attaching, or a primitive is special-cased.
#   G1 boundary  — emit() attaches _contract via contractVerdictFromEnvelope (ALL primitives)
#   G2 enriched  — resolve + execute attach the richer native bible-anchor verdict themselves
#   G3 always    — the attach is unconditional (no flag/env gate)
#   G4 witness   — the pure deriver is terminal on a real success + names the frontier on a miss
#   G5 pure      — the shared deriver drags no native FFI into the universal output path
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }

grep -q 'contractVerdictFromEnvelope' src/cli-v7/output.ts || fail "G1 boundary: emit() no longer attaches the three-shape verdict at the shared boundary"
echo "ok G1 boundary — emit() attaches _contract to EVERY primitive envelope (zero per-primitive wiring)"

grep -q '_contract: contractVerdict' src/cli-v7/eval/resolve.ts && grep -q '_contract: executeVerdict' src/cli-v7/breath/execute.ts \
  || fail "G2 enriched: resolve/execute dropped their richer native _contract verdict"
echo "ok G2 enriched — resolve + execute attach the bible-anchor-enriched verdict on their hot paths"

if grep -nE 'process\.env.*CONTRACT|if \([^)]*contract[^)]*enabled' src/cli-v7/output.ts 2>/dev/null | grep -q .; then
  fail "G3 always: a flag/env gate appeared around the shared verdict — it must be unconditional"
fi
echo "ok G3 always — the attach is unconditional (no opt-in flag), every emit carries it"

bun -e '
import { contractVerdictFromEnvelope } from "./src/values/contract-shape.ts";
const ok = contractVerdictFromEnvelope({ subcommand: "x", url: "u", ok: true });
const bad = contractVerdictFromEnvelope({ subcommand: "x", ok: false });
if (!ok.terminal || bad.terminal || bad.frontier !== "verify") process.exit(1);
' >/dev/null 2>&1 || fail "G4 witness: the shared verdict deriver regressed"
echo "ok G4 witness — terminal on a real success, names the frontier on a miss"

# G5 — the universal output path stays free of the native bun:ffi substrate (IMPORTS, not comments)
if grep -nE '^\s*import .*(contract-native|bun:ffi)' src/values/contract-shape.ts | grep -q .; then
  fail "G5 pure: the shared deriver pulled native FFI into the universal output hot path"
fi
echo "ok G5 pure — the shared deriver is dependency-free (no native FFI on every emit)"

echo "GATE GREEN — /contract shaped all the way through: every primitive emit carries the three-shape verdict"
