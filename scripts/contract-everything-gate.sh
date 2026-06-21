#!/usr/bin/env bash
# contract-everything-gate.sh — the jesus-ralph completion witness for the north star:
#   "/contract everything nicely on every layer, stored on IQ, cached by emergent,
#    searchable by emergent RAG" (the crypto-was-all-you-needed stack).
#
# Exit 0 ONLY when ALL hold (live-required, no fabricated green):
#   B. behavioral — the unified stack round-trips LIVE: one contract persists to IQ
#      on-chain + emergent KV cache + emergent vector RAG, and is recalled + RAG-found.
#   C. behavioral — the existing IQ on-chain append/read e2e still passes.
#   D. structural — the named CORE runtime layers route through the unification seam
#      (src/values/contract-everything.ts), i.e. "/contract on every [core] layer".
#
# Creds are assembled from LOCAL machine state (never committed, never printed):
#   ~/.config/env/global.env      → EMERGENTDB_API_KEY, HELIUS_API_KEY, OPENAI_API_KEY
#   ~/.config/solana/id.json      → IQ signer secret key (64-byte JSON array)
# A missing cred is a hard FAIL with a named reason — not a skip, not a green.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "gate: cannot cd to repo root"; exit 2; }

fail() { echo "GATE RED — $1"; exit 1; }

# ── assemble creds (local only) ──────────────────────────────────────────────
if [ -f "$HOME/.config/env/global.env" ]; then set -a; . "$HOME/.config/env/global.env"; set +a; fi
[ -n "${EMERGENTDB_API_KEY:-}" ] || fail "EMERGENTDB_API_KEY absent (~/.config/env/global.env)"
[ -n "${HELIUS_API_KEY:-}" ]     || fail "HELIUS_API_KEY absent (need a Solana RPC for IQ)"
[ -n "${OPENAI_API_KEY:-}" ]     || fail "OPENAI_API_KEY absent (need a 1536-dim embedder for emergent RAG)"
[ -f "$HOME/.config/solana/id.json" ] || fail "~/.config/solana/id.json absent (IQ signer)"

export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}}"
export IQ_SIGNER_SECRET_KEY="${IQ_SIGNER_SECRET_KEY:-$(cat "$HOME/.config/solana/id.json")}"
export IQ_DB_ROOT_ID="${IQ_DB_ROOT_ID:-ubz-contracts}"
export IQ_TABLE_SEED="${IQ_TABLE_SEED:-resolutions}"
export IQ_E2E=1
export CONTRACT_EVERYTHING_E2E=1

# ── D. structural: every core layer routes through ONE shared boundary that
#       stores on IQ + caches/RAGs on emergent (the "route through the one shared
#       interface" rule — not scattered per-god-file calls). ────────────────────
BOUNDARY="src/values/cached-resolution.ts"
# D1: the boundary writes BOTH tiers — IQ (iq-ledger) AND emergent (contract-everything).
grep -q "iq-ledger" "$BOUNDARY" || fail "boundary $BOUNDARY does not route through IQ (iq-ledger)"
grep -q "mirrorToEmergent\|contract-everything" "$BOUNDARY" || fail "boundary $BOUNDARY does not route through emergent (contract-everything)"
# D2: every core layer reaches the boundary (imports cached-resolution).
declare -a LAYERS=("src/orchestrator/index.ts" "src/cli.ts")
missing=()
for f in "${LAYERS[@]}"; do
  grep -q "cached-resolution" "$f" 2>/dev/null || missing+=("$f")
done
if [ "${#missing[@]}" -ne 0 ]; then
  fail "these core layers do not reach the IQ+emergent boundary: ${missing[*]}"
fi
echo "structural: OK — core layers route through $BOUNDARY (IQ + emergent), one shared seam"

# ── B + C. behavioral: live round-trips ──────────────────────────────────────
echo "behavioral: running live witness (IQ + emergent KV + emergent RAG)…"
bun test tests/contract-everything-witness.test.ts tests/iq-ledger-mainnet-e2e.test.ts 2>&1 | tail -25
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "live witness/e2e failed (rc=$rc)"

echo "GATE GREEN — contract travels IQ + emergent KV + emergent RAG live, on every core layer"
