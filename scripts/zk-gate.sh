#!/usr/bin/env bash
# zk-gate — the witness for the signed, layer-descending ZK stack (the whitepaper
# *Internal APIs Were Not All You Needed*, moved reference -> production, gated).
#
# Two binding checks, both runnable, no fabricated green:
#   1. The PRODUCTION ZK primitives pass their real-crypto tests (the [proposed]
#      frontier becoming [shipped], one node at a time — append tests as they land).
#   2. The paper stays HONEST: paper-gate verifies every [shipped] claim maps to a
#      real code anchor and no moat term leaks.
#
# Exits 0 iff both are green. This is a building loop over a research agenda (the
# paper itself calls the [proposed] list "not a feature list with a release date"),
# so the gate certifies each landed node is real + the paper never overclaims — it
# does not assert the whole vision is finished.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

echo "=== production ZK primitives (real crypto, real tests) ==="
ZK_TESTS=(
  tests/wallet-seal.test.ts      # sealed-unless-revealed (AES-GCM under the wallet key)
  tests/sealed-cache.test.ts     # commit-reveal (hash commitment, prove-without-revealing)
)
if ! bun test "${ZK_TESTS[@]}"; then
  echo "[zk-gate] FAIL — production ZK primitive tests red"
  exit 1
fi

echo
echo "=== paper honesty (no fabricated green; [shipped] -> code; no moat leak) ==="
if ! bash scripts/paper-gate.sh paper/internal-apis.tex; then
  echo "[zk-gate] FAIL — paper-gate red (a claim overclaims, or a moat term leaked)"
  exit 1
fi

echo
echo "[zk-gate] PASS — production ZK primitives green + paper honest"
