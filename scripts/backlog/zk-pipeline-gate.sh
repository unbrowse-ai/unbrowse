#!/usr/bin/env bash
# zk-pipeline-gate.sh — witness for zk-pipeline-compose.
#
# The two-witness corroboration that the session's primitives COMPOSE into the
# user's north star end-to-end (not just pass in isolation): browse with
# credentials → EVERYTHING obfuscated + sealed to the wallet → the backend
# reverse-engineers + sees only the HOLES (never a secret) → the client fills
# the holes from the wallet-sealed vault → the concrete request is reconstructed
# locally, secrets never leaving the wallet-holder. Verifies:
#   1. the three composed engines build together (obfuscate + hole-template +
#      wallet-vault),
#   2. WITNESS A: the wire to the backend (skeleton + holes) carries NO secret;
#      WITNESS B: the client reconstructs the REAL request from the wallet vault;
#      and an attacker wallet cannot open the vault — via the test.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/capture/obfuscate.ts src/capture/hole-template.ts src/vault/wallet-vault.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "zk-pipeline-gate: FAIL — composed engines do not build"; exit 1
fi

if ! bun test tests/zk-pipeline-composition.test.ts >/dev/null 2>&1; then
  echo "zk-pipeline-gate: FAIL — end-to-end composition test red"; exit 1
fi

echo "zk-pipeline-gate: ok — full loop composes: obfuscated wire leaks no secret, client reconstructs the real request from the wallet vault, attacker locked out"
exit 0
