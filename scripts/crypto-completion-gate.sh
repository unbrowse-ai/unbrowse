#!/usr/bin/env bash
# crypto-completion-gate.sh — the BINDING witness for the crypto-was-all-you-needed
# completion plan (docs/crypto-was-all-you-needed-completion-plan.md). Exits 0 ONLY when
# every phase's own real witness passes. RED until all seven genuinely ship — no
# self-asserted green. This is the machine gate the jesus-ralph loop pins instead of a
# weak promise string. Run twice for the two-witness rule.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail=0
ok(){ printf '  ok   %s\n' "$1"; }
bad(){ printf '  RED  %s\n' "$1"; fail=1; }

echo "=== crypto-completion-gate ==="

# Phase 1 — sealed-value member (pure core + on-chain wrappers), deterministic.
bun test tests/iq-sealed-value.test.ts >/dev/null 2>&1 \
  && ok "P1 sealed-value member (tests/iq-sealed-value.test.ts)" \
  || bad "P1 sealed-value member"

# Phase 0 foundation — IQ ledger + wallet-first + write-through (regression guard).
bun test tests/iq-ledger.test.ts tests/iq-mirror-resolution.test.ts tests/wallet-identity-autoregister.test.ts >/dev/null 2>&1 \
  && ok "P0 IQ ledger + write-through + wallet-first" \
  || bad "P0 foundation"

# Phase 2 — cold-hydrate (read-from-chain). Witness file lands when the phase ships.
if [ -f tests/iq-cold-hydrate.test.ts ]; then
  bun test tests/iq-cold-hydrate.test.ts >/dev/null 2>&1 && ok "P2 cold-hydrate" || bad "P2 cold-hydrate (test red)"
else bad "P2 cold-hydrate — not built (tests/iq-cold-hydrate.test.ts missing)"; fi

# Phase 3 — hole→on-chain-sealed-value wallet-gated reveal wired e2e.
if [ -f tests/iq-sealed-hole-e2e.test.ts ]; then
  bun test tests/iq-sealed-hole-e2e.test.ts >/dev/null 2>&1 && ok "P3 sealed-hole e2e" || bad "P3 sealed-hole e2e (test red)"
else bad "P3 sealed-hole e2e — not built (tests/iq-sealed-hole-e2e.test.ts missing)"; fi

# Phase 4 — frontend wallet-render surface, deployed + visually verified.
if [ -f .claude/phase4-frontend-verified.marker ]; then
  ok "P4 frontend wallet-render (deploy-verified marker present)"
else bad "P4 frontend wallet-render — not deployed/verified (marker missing)"; fi

# Phase 5 — emergentdb KV + emergent-graph contract search.
if [ -f tests/emergentdb-contract-search.test.ts ]; then
  bun test tests/emergentdb-contract-search.test.ts >/dev/null 2>&1 && ok "P5 emergentdb search" || bad "P5 emergentdb search (test red)"
else bad "P5 emergentdb search — not built (tests/emergentdb-contract-search.test.ts missing)"; fi

# Phase 6 — native, in-process plan+execute (the local reading of "make planning+execution
# native", per Local-runtime-authority; user-confirmed 2026-06-21). The cloud-DEPLOYED runtime
# emission of the same shape (live endpoint, currently paused) is a documented external follow-up.
bun test tests/plan-drill.test.ts >/dev/null 2>&1 \
  && ok "P6 native plan+execute engine (tests/plan-drill.test.ts) — cloud deploy = external follow-up" \
  || bad "P6 native plan+execute engine"

# Phase 7 — paper reflects shipped code, no moat leak.
bash scripts/paper-gate.sh paper/crypto-was-all-you-needed.tex >/dev/null 2>&1 \
  && ok "P7 paper reflects code (paper-gate)" || bad "P7 paper-gate"

echo
if [ "$fail" -ne 0 ]; then echo "CRYPTO-COMPLETION-GATE RED — not all seven phases shipped+witnessed."; exit 1; fi
echo "CRYPTO-COMPLETION-GATE GREEN — all seven phases shipped and witnessed."
