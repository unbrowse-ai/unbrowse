#!/usr/bin/env bash
# zk-delta-gate — the witness for the ZK-gated delta-contribution frontier
# (internal/zk-delta-contribution-plan.md): a remote skill execution yields a
# route-delta admitted into the shared graph ONLY behind a validity proof + an
# origin attestation bound to the contributor's wallet — no private capture revealed.
#
# Like zk-gate.sh, this is a CHECKLIST gate: each spine node is a real test that must
# exist AND pass. A node whose test file is absent is UNBUILT — the gate fails and
# points at the next one to build. Exit 0 only when every autonomously-shippable node
# is real + tested AND the contributor/boundary discipline holds (the client proves,
# the server verifies; no secret/credential on the contribution wire).
#
# Scope note (honest, mirrors zk-gate): full MPC-TLS notarization (node 3) and live
# on-chain checkpoint + x402 settlement (nodes 4-5) need an external notary / chain;
# those are the DEPLOYMENT step. This gate settles the in-process reference+production
# crypto and merge logic — the host is swapped later, the proofs never change.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

# spine node : the production/reference test that witnesses it (plan §"phased build plan")
NODES=(
  # 1 — the contributed unit: content-addressed, signed, tamper-evident route-delta
  "route-delta:tests/route-delta.test.ts"
  # 2 — bounded-delta validity proof: NIZK that the delta soundly projects a wallet-bound
  #     capture within bound B (honest delta verifies; injected/oversized fails closed)
  "delta-validity-proof:tests/delta-proof.test.ts"
  # 3 — execution attestation: response-shape bound to origin + wallet root, signed
  #     (verifies for a real capture; replay / origin-swap fails). MPC-TLS notary = deploy step.
  "exec-attestation:tests/exec-attest.test.ts"
  # 4 — ZK-gated CRDT merge: two agents' deltas merge conflict-free into the shared graph
  #     root; an unproven delta is rejected; the merged root is reproducible (two witnesses)
  "graph-merge-gated:tests/graph-merge.test.ts"
  # 5 — validation-registry gate (ERC-8004 shape): verify proofs #2+#3 before admit, record
  #     the verified contribution for the x402 split; a forged proof is rejected end-to-end
  "contribution-gate:tests/contribution-gate.test.ts"
  # 6 — no-secret-leak on the WRITE path: the delta + proofs carry only one-way commitments,
  #     never a secret value (extends revengEgressPayload's invariant to the contribution payload)
  "contribution-no-leak:tests/contribution-no-leak.test.ts"
)

todo=0; done=0; pending_tests=()
echo "=== zk-delta frontier: $(printf '%s ' "$(date -u +%Y-%m-%dT%H:%MZ)")==="
for entry in "${NODES[@]}"; do
  name="${entry%%:*}"; test="${entry#*:}"
  if [ -f "$test" ]; then
    echo "  built  [$name] -> $test"; done=$((done+1)); pending_tests+=("$test")
  else
    echo "  TODO   [$name] -> $test (build it next)"; todo=$((todo+1))
  fi
done
echo "  nodes: $done built / $todo unbuilt (target: 6/0)"

# Every built node's test must be GREEN — no fabricated green.
if [ "${#pending_tests[@]}" -gt 0 ]; then
  echo "=== running ${#pending_tests[@]} built-node test(s) ==="
  if ! bun test "${pending_tests[@]}"; then
    echo "[zk-delta] FAIL — a built node's test is red"; exit 1
  fi
fi

# Boundary discipline: the inference/verification PROVER is server-only. No client (src/)
# file may import a backend prover/merge service — the client constructs + proves, the
# server verifies (mirrors thin-client-gate). The contribution route + merge live in backend/.
bad=$(git grep -lE "(from|import\()\s*['\"][^'\"]*backend/src/(services/graph-merge|routes/contribution)" -- src 2>/dev/null || true)
if [ -n "$bad" ]; then
  echo "[zk-delta] FAIL — client (src/) imports the SERVER-ONLY contribution/merge service:"
  echo "$bad" | sed 's/^/    /'
  exit 1
fi

if [ "$todo" -gt 0 ]; then
  echo "[zk-delta] NOT YET — $todo node(s) unbuilt; built nodes + boundary are green. Keep walking."
  exit 1
fi
echo "[zk-delta] PASS — every ZK-delta-contribution node is real + tested + boundary-honest"
