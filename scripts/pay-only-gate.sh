#!/usr/bin/env bash
# pay-only-gate.sh — standing luminary for the user directive
# "no need for ows or any other adapters, just pay.sh is fine".
# Exits 0 only when pay.sh is the SOLE live wallet adapter:
#   G1 behaviour — resolveWalletConfig returns ONLY pay (default + any name) / none (opt-out).
#   G2 source    — the resolver returns no other adapter name on a live path.
# Falsifiable: re-adding a lobster/privy/generic/base/ows branch to the resolver turns this red.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }

# G1 — runtime behaviour
OUT="$(bun -e '
import {resolveWalletConfig as r} from "./src/payments/x402-fetch.ts";
const d=r({}).adapter, n=r({UNBROWSE_WALLET_ADAPTER:"none"}).adapter;
const b=r({UNBROWSE_WALLET_ADAPTER:"base"}).adapter, l=r({UNBROWSE_WALLET_ADAPTER:"lobster"}).adapter;
console.log(JSON.stringify({d,n,b,l}));
' 2>/dev/null)"
echo "$OUT" | grep -q '"d":"pay"' || fail "G1: default adapter is not pay ($OUT)"
echo "$OUT" | grep -q '"n":"none"' || fail "G1: none opt-out broken ($OUT)"
echo "$OUT" | grep -q '"b":"pay"' || fail "G1: base did not collapse to pay ($OUT)"
echo "$OUT" | grep -q '"l":"pay"' || fail "G1: lobster did not collapse to pay ($OUT)"
echo "ok G1 behaviour — resolver yields only pay/none ($OUT)"

# G2 — the resolver body returns no other adapter name on a live path
BODY="$(awk '/export function resolveWalletConfig/,/^}/' src/payments/x402-fetch.ts)"
if printf '%s' "$BODY" | grep -qE 'adapter: *"(lobster|privy|generic|base|ows)"'; then
  fail "G2: resolveWalletConfig still returns a non-pay adapter"
fi
echo "ok G2 source — resolver returns no lobster/privy/generic/base/ows"
echo "GATE GREEN — pay.sh is the sole live wallet adapter"
