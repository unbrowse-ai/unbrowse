#!/usr/bin/env bash
# zk-gate — the witness for moving the whitepaper's [proposed] ZK-credential-binding
# frontier (*Internal APIs Were Not All You Needed*) from runnable REFERENCE
# (paper/reference/*.py) into real PRODUCTION code, one node at a time, never
# fabricated-green.
#
# It is a CHECKLIST gate (like the original backlog gate): each node is a real
# production test that must exist AND pass. Nodes whose test file is absent are
# UNBUILT — the gate fails and points at the next one to build. The gate exits 0
# only when every autonomously-shippable ZK node is real + tested AND the paper
# stays honest (paper-gate: [shipped] -> code anchor, no moat leak).
#
# Scope note (honest): some paper [proposed] items need on-chain / kernel / hardware
# (ERC-8004 registry, FDRY slashing, signed OS/kernel descent to the packet) and are
# NOT autonomously completable here; they are out of this gate's checklist by design.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

# node-name : production test file (the witness that the node is real)
NODES=(
  # --- primitives (reference -> production) ---
  "sealed-unless-revealed:tests/wallet-seal.test.ts"     # AES-GCM seal under the wallet key
  "commit-reveal:tests/sealed-cache.test.ts"             # hash commitment, prove-without-revealing
  "zk-credential-binding:tests/zk-binding.test.ts"       # Schnorr NIZK: credential bound, never revealed
  "signed-layer-descent:tests/signed-descent.test.ts"    # hash-chained per-layer signatures, one wallet root
  "sealed-ledger:tests/sealed-ledger.test.ts"            # content-addressed, sealed, hash-chained ledger rows
  # --- integration: the backend harness surfaces only holes; values ZK'd to the wallet ---
  "sealed-hole-fill:tests/sealed-fill.test.ts"           # hole fills sealed to the wallet, revealed locally by the holder only
  "zk-bound-hole:tests/zk-bound-hole.test.ts"            # a secret hole carries a real ZK binding; backend verifies bound w/o the secret
)

todo=0; done=0; pending_tests=()
for entry in "${NODES[@]}"; do
  name="${entry%%:*}"; test="${entry#*:}"
  if [ -f "$test" ]; then
    echo "  built  [$name] -> $test"; done=$((done+1)); pending_tests+=("$test")
  else
    echo "  TODO   [$name] -> $test (build it next)"; todo=$((todo+1))
  fi
done
echo "  nodes: $done built / $todo unbuilt"

# Every built node's test must be GREEN.
if [ "${#pending_tests[@]}" -gt 0 ]; then
  echo "=== running ${#pending_tests[@]} built-node test(s) ==="
  if ! bun test "${pending_tests[@]}"; then
    echo "[zk-gate] FAIL — a built ZK node's test is red"; exit 1
  fi
fi

# Paper must stay honest regardless.
echo "=== paper honesty (no fabricated green; [shipped] -> code; no moat leak) ==="
if ! bash scripts/paper-gate.sh paper/internal-apis.tex; then
  echo "[zk-gate] FAIL — paper-gate red"; exit 1
fi

if [ "$todo" -gt 0 ]; then
  echo "[zk-gate] NOT YET — $todo ZK node(s) still unbuilt; built nodes + paper are green. Keep walking."
  exit 1
fi
echo "[zk-gate] PASS — every autonomously-shippable ZK node is real + tested + paper-honest"
