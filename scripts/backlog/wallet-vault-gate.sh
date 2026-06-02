#!/usr/bin/env bash
# wallet-vault-gate.sh — witness for wallet-vault.
#
# The node (the user's "any key value ZK'ed to their wallet only for them to
# use" + the last stateless gap): the credential vault sealed to the wallet —
# the client holds only opaque sealed blobs, only the wallet-holder opens them,
# and the host-independent content-address lets them live in the backend KV
# (stateless). Verifies:
#   1. the wallet-vault module builds (over the d41 sealToWallet primitive),
#   2. credentials round-trip for the holder, fail closed for any other wallet,
#      leak no plaintext, are account-scoped, and export/import (backend KV
#      round-trip) preserves holder-only access — via the test.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/vault/wallet-vault.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "wallet-vault-gate: FAIL — wallet-vault module does not build"; exit 1
fi

if ! bun test tests/wallet-vault.test.ts >/dev/null 2>&1; then
  echo "wallet-vault-gate: FAIL — wallet-vault test red"; exit 1
fi

echo "wallet-vault-gate: ok — credentials sealed to the wallet (only the holder opens, no plaintext leak, account-scoped, backend-round-trip safe)"
exit 0
