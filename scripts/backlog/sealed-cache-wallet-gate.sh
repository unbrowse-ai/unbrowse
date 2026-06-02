#!/usr/bin/env bash
# sealed-cache-wallet-gate.sh — witness for sealed-cache-wallet.
#
# The node (Paper 2 §5, the user's "any key value bound to their wallet, only for
# them to use"): the sealed-unless-revealed cache, bound to the wallet — a value
# is sealed under a key only the holder's wallet can derive, so ONLY the holder
# retrieves the plaintext, while the content-address stays host-independent.
# Verifies:
#   1. the sealed-cache module builds (Web Crypto HKDF + AES-GCM),
#   2. the wallet seal round-trips for the holder, fails closed for any other
#      wallet, leaks no plaintext, content-address is host-independent,
#      info-scoped + tamper-evident — AND the prior commit-reveal stays green.
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/trust/sealed-cache.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "sealed-cache-wallet-gate: FAIL — sealed-cache module does not build"; exit 1
fi

if ! bun test tests/wallet-sealed-cache.test.ts tests/sealed-cache.test.ts >/dev/null 2>&1; then
  echo "sealed-cache-wallet-gate: FAIL — wallet-seal or commit-reveal test red"; exit 1
fi

echo "sealed-cache-wallet-gate: ok — value sealed to the wallet (only the holder opens, fails closed for others, no plaintext leak, host-independent content-address)"
exit 0
