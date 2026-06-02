#!/usr/bin/env bash
# wallet-bind-gate.sh — witness for wallet-bind-secrets.
#
# The node: each obfuscated secret is BOUND to the owner's wallet identity
# (owner-only use) — the secular commitment layer the whitepaper's ZK later
# strengthens. Verifies:
#   1. the wallet-bind module builds (createHash commitment + verify),
#   2. the binding properties hold (hides the secret, binds to the wallet,
#      only the secret-holder can open it) AND the obfuscation emits
#      owner-verifiable bound tags with no secret leak — via the test,
#   3. the prior obfuscate witness stays green (backward compatible: no wallet
#      still yields flat [REDACTED]).
set -uo pipefail
cd "$(dirname "$0")/../.."

# 1. The binding module builds.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! bun build src/capture/wallet-bind.ts src/capture/obfuscate.ts \
     --target=node --outdir="$tmp" >/dev/null 2>&1; then
  echo "wallet-bind-gate: FAIL — wallet-bind / obfuscate modules do not build"; exit 1
fi

# 2 + 3. Binding properties + obfuscation integration + backward-compat, all green.
if ! bun test tests/wallet-bind.test.ts tests/capture-obfuscate.test.ts >/dev/null 2>&1; then
  echo "wallet-bind-gate: FAIL — wallet-bind or obfuscate test red"; exit 1
fi

echo "wallet-bind-gate: ok — secrets bound to wallet (hidden, bound, owner-only-open), obfuscation emits verifiable bound tags, no leak"
exit 0
