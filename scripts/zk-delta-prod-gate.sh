#!/usr/bin/env bash
# zk-delta-prod-gate — the witness for production-hardening the ZK-gated delta
# contribution (plan.md): dedicated store, pluggable notary attestation carrier,
# on-chain-ready checkpoint with inclusion proofs, and contributor payout across the
# four-way split. Like zk-delta-gate, a CHECKLIST gate: each node is a real test that
# must exist AND pass. A node whose test is absent is UNBUILT (gate fails, points at the
# next). Exit 0 only when every node is real + tested AND the prover/verifier boundary holds.
#
# Honest scope (mirrors zk-gate): the EXTERNAL wiring — MPC-TLS notary service, on-chain
# root publication, live USDC transfer — is the DEPLOY step and out of this gate by design.
# This settles the in-process reference + production logic those steps plug into.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

NODES=(
  # 1 — dedicated graph KV binding resolution (isolated from analytics), graceful fallback
  "dedicated-graph-kv:tests/graph-store-dedicated.test.ts"
  # 2 — pluggable attestation proof carrier: wallet-sig OR notary proof; verify dispatches
  "notary-attestation:tests/notary-attest.test.ts"
  # 3 — checkpoint with RFC-6962 inclusion proofs (the value an on-chain anchor publishes)
  "onchain-checkpoint:tests/graph-checkpoint.test.ts"
  # 4 — contributor payout across the four-way fare split; paid to the verified winner only
  "contributor-payout:tests/contributor-payout.test.ts"
)

todo=0; done=0; pending_tests=()
echo "=== zk-delta production-hardening: $(date -u +%Y-%m-%dT%H:%MZ) ==="
for entry in "${NODES[@]}"; do
  name="${entry%%:*}"; test="${entry#*:}"
  if [ -f "$test" ]; then
    echo "  built  [$name] -> $test"; done=$((done+1)); pending_tests+=("$test")
  else
    echo "  TODO   [$name] -> $test (build it next)"; todo=$((todo+1))
  fi
done
echo "  nodes: $done built / $todo unbuilt (target: 4/0)"

if [ "${#pending_tests[@]}" -gt 0 ]; then
  echo "=== running ${#pending_tests[@]} built-node test(s) ==="
  if ! bun test "${pending_tests[@]}"; then
    echo "[zk-delta-prod] FAIL — a built node's test is red"; exit 1
  fi
fi

# Boundary: the client (src/) must not import the SERVER-ONLY checkpoint/payout services.
bad=$(git grep -lE "(from|import\()\s*['\"][^'\"]*backend/src/(services/graph-checkpoint|services/graph-merge|routes/contribution)" -- src 2>/dev/null || true)
if [ -n "$bad" ]; then
  echo "[zk-delta-prod] FAIL — client (src/) imports a SERVER-ONLY service:"
  echo "$bad" | sed 's/^/    /'
  exit 1
fi

if [ "$todo" -gt 0 ]; then
  echo "[zk-delta-prod] NOT YET — $todo node(s) unbuilt; built nodes + boundary are green. Keep walking."
  exit 1
fi
echo "[zk-delta-prod] PASS — production-hardening nodes are real + tested + boundary-honest"
