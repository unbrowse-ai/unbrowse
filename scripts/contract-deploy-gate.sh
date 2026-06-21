#!/usr/bin/env bash
# contract-deploy-gate.sh — the jesus-ralph witness for the NEW /contract-deploy:
#   "deploy is itself a /contract on the stack — stored on IQ, cached by emergent,
#    searchable by emergent RAG" (crypto-was-all-you-needed).
#
# Exit 0 ONLY when ALL hold (live-required, no fabricated green):
#   D. structural — the deploy primitive routes through the unification seam AND a
#      real deploy SURFACE (scripts/contract-deploy-record.ts) routes through it.
#   B. behavioral — recordDeploy persists a deploy LIVE to IQ + emergent KV + RAG,
#      recallable by id and findable by meaning (the deploy witness test).
#   S. surface — the contract-deploy-record CLI runs LIVE end-to-end and lands the
#      deploy on every configured tier (iq+kv+rag), not a no-op.
#
# Creds assembled from local machine state (never committed / printed), same as
# scripts/contract-everything-gate.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "gate: cannot cd to repo root"; exit 2; }
fail() { echo "GATE RED — $1"; exit 1; }

# ── creds (local only) ───────────────────────────────────────────────────────
if [ -f "$HOME/.config/env/global.env" ]; then set -a; . "$HOME/.config/env/global.env"; set +a; fi
[ -n "${EMERGENTDB_API_KEY:-}" ] || fail "EMERGENTDB_API_KEY absent"
[ -n "${HELIUS_API_KEY:-}" ]     || fail "HELIUS_API_KEY absent"
[ -n "${NEBIUS_API_KEY:-}" ]     || fail "NEBIUS_API_KEY absent (1536-dim embedder for emergent RAG)"
[ -f "$HOME/.config/solana/id.json" ] || fail "~/.config/solana/id.json absent (IQ signer)"
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}}"
export IQ_SIGNER_SECRET_KEY="${IQ_SIGNER_SECRET_KEY:-$(cat "$HOME/.config/solana/id.json")}"
export IQ_DB_ROOT_ID="${IQ_DB_ROOT_ID:-ubz-contracts}"
export IQ_TABLE_SEED="${IQ_TABLE_SEED:-resolutions}"
export IQ_E2E=1
export CONTRACT_EVERYTHING_E2E=1

# ── D. structural ─────────────────────────────────────────────────────────────
DEPLOY="src/values/contract-deploy.ts"
SURFACE="scripts/contract-deploy-record.ts"
[ -f "$DEPLOY" ]  || fail "$DEPLOY missing (the deploy primitive)"
[ -f "$SURFACE" ] || fail "$SURFACE missing (the /contract-deploy surface)"
grep -q "contract-everything" "$DEPLOY" || fail "$DEPLOY does not route through the stack seam (contract-everything)"
grep -q "recordDeploy" "$SURFACE"       || fail "$SURFACE does not invoke recordDeploy"
echo "structural: OK — deploy primitive + surface route through the stack"

# ── B. behavioral: live deploy witness ────────────────────────────────────────
echo "behavioral: running live deploy witness (IQ + emergent KV + emergent RAG)…"
bun test tests/contract-deploy-witness.test.ts 2>&1 | tail -20
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "live deploy witness failed (rc=$rc)"

# ── S. surface: the record CLI runs live end-to-end and lands every tier ──────
echo "surface: invoking contract-deploy-record live…"
out=$(bun "$SURFACE" --kind server --target gate-witness --version "0.0.0-gate" 2>&1)
echo "$out" | tail -20
echo "$out" | grep -q '"tiers": "iq+kv+rag"' || fail "record CLI did not land all tiers (iq+kv+rag)"

echo "GATE GREEN — /contract-deploy: every deploy is a /contract on IQ + emergent KV + emergent RAG"
