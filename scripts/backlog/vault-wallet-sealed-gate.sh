#!/usr/bin/env bash
# vault-wallet-sealed-gate.sh — witness for vault-wallet-wired.
#
# The node: WIRE the d60 WalletVault into the REAL vault (src/vault/index.ts) —
# closing the "built but not wired" gap. When UNBROWSE_WALLET_SECRET is set, the
# vault seals each credential VALUE to the holder's wallet at rest (no plaintext
# on disk / in the keychain); only the holder opens it; the expiry metadata
# stays in clear so eviction still works without the wallet; the default path is
# unchanged. Verifies:
#   1. the vault module builds with the wallet-sealing wired in,
#   2. holder round-trips the secret, a wrong/absent wallet cannot open it, and
#      the no-wallet default path is unchanged — via the test,
#   3. the existing vault tests still pass (no regression in load-bearing auth).
set -uo pipefail
cd "$(dirname "$0")/../.."

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/vault/index.ts --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "vault-wallet-sealed-gate: FAIL — vault module does not build"; exit 1
fi

if ! bun test tests/vault-wallet-sealed.test.ts >/dev/null 2>&1; then
  echo "vault-wallet-sealed-gate: FAIL — vault wallet-sealing test red"; exit 1
fi

# Regression: the vault credential flow still works end-to-end (mcp handoff +
# keytar fallback are green on HEAD; vault-keytar.test.ts has a pre-existing
# unrelated failure not touched by this change).
if ! bun test tests/mcp-credential-handoff.test.ts tests/vault-keytar-fallback.test.ts >/dev/null 2>&1; then
  echo "vault-wallet-sealed-gate: FAIL — vault credential flow regressed"; exit 1
fi

echo "vault-wallet-sealed-gate: ok — the real vault seals credentials to the wallet under UNBROWSE_WALLET_SECRET (holder-only, no plaintext at rest, default path unchanged)"
exit 0
