#!/usr/bin/env bash
# wallet-adapter-gate.sh — runnable witness for native wallet-adapter support:
#   Wallet Standard (open-wallet-standard / @wallet-standard) + lobster.cash, with
#   an OPTIONAL unbrowse-default wallet, wired through the zero-dep SDK + frontend
#   + docs, lobster.cash-compatible (capability-level wording, Solana/USDC/PDA x402).
#
# Exits 0 ONLY when every node settles. Granular PASS/FAIL so partial progress shows.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
fail=0
pass(){ printf '\033[32mPASS\033[0m %s\n' "$1"; }
bad(){ printf '\033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
sec(){ printf '\n— %s —\n' "$1"; }

sec "W. WALLET STANDARD (OWS) + lobster.cash adapters"

# W1: SDK consumes any Wallet Standard wallet → x402 PayHandler, ZERO-DEP
#     (structural types, no @wallet-standard import in the shipped SDK).
SDKW=src/sdk/wallet-standard.ts
if [ -f "$SDKW" ] \
   && grep -qE 'walletStandardPay' "$SDKW" \
   && grep -qiE 'solana:signMessage|signMessage' "$SDKW" \
   && grep -qE 'standard:connect|connect' "$SDKW"; then
  if grep -qE "from ['\"]@wallet-standard" "$SDKW"; then
    bad "W1: $SDKW imports @wallet-standard — the shipped SDK must stay zero-dep (use structural types)"
  else
    pass "W1: $SDKW consumes a Wallet Standard wallet → PayHandler (zero-dep, structural)"
  fi
else
  bad "W1: $SDKW missing — need walletStandardPay(wallet) → PayHandler (connect + signMessage)"
fi

# W2: an OPTIONAL unbrowse-default wallet (our servers + our API key), registerable
#     as a Wallet Standard wallet. Must be opt-in (env/flag gated), not forced.
if [ -f "$SDKW" ] && grep -qiE 'makeUnbrowseWallet|unbrowseDefaultWallet|UnbrowseWallet' "$SDKW" \
   && grep -qiE 'optional|opt-in|UNBROWSE_API_KEY|api[_ ]?key' "$SDKW"; then
  pass "W2: optional unbrowse-default wallet factory present (our servers/API key, opt-in)"
else
  bad "W2: no optional unbrowse-default wallet factory (makeUnbrowseWallet, opt-in via API key)"
fi

# W3: the PayHandler is wired to the SDK fetch seam (createFetch/PayHandler type).
if grep -qE 'PayHandler' "$SDKW" 2>/dev/null && grep -qE 'PayHandler' src/sdk/fetch.ts 2>/dev/null; then
  pass "W3: wallet adapter produces the SDK PayHandler (createFetch payment seam)"
else
  bad "W3: wallet adapter not typed to the SDK PayHandler seam (src/sdk/fetch.ts)"
fi

# W4: frontend has a Wallet Standard connect surface (real @wallet-standard usage).
FEW=$(find frontend/src -maxdepth 3 -iname '*wallet-standard*' 2>/dev/null | head -1)
if [ -n "$FEW" ] && grep -rqE "getWallets|@wallet-standard|useSolanaStandardWallets|registerWallet" "$FEW" 2>/dev/null; then
  pass "W4: frontend Wallet Standard connect surface present ($FEW)"
else
  bad "W4: no frontend Wallet Standard connect surface (frontend/src/**/wallet-standard*)"
fi

# W5: lobster.cash listed as a compatible + tested wallet (directory certification).
WDOC=docs/for-agents/wallets-and-payments.md
if [ -f "$WDOC" ] && grep -qiE 'lobster\.cash' "$WDOC" && grep -qiE 'compatible|tested' "$WDOC" && grep -qiE 'wallet standard' "$WDOC"; then
  pass "W5: $WDOC lists lobster.cash as a compatible/tested wallet + Wallet Standard"
else
  bad "W5: $WDOC missing/incomplete (lobster.cash compatible+tested + Wallet Standard)"
fi

# W6: capability-level wording — delegate to the wallet, NO hardcoded lobster action
#     names in user-facing docs (per the lobster.cash integration spec).
if [ -f "$WDOC" ]; then
  if grep -qiE 'delegate|bring your own wallet|wallet (handles|owns|signs)' "$WDOC" \
     && ! grep -qE 'lobstercash [a-z]|lobster\.cash/(action|api)/[a-z]' "$WDOC"; then
    pass "W6: capability-level wording (delegates to wallet; no hardcoded lobster action names)"
  else
    bad "W6: doc must use capability wording (delegate) and not hardcode lobster action names"
  fi
else
  bad "W6: $WDOC missing (cannot check capability wording)"
fi

# W7: x402 facilitator supports Solana + USDC + PDA smart-wallets.
if grep -qE 'supports_pda_wallets' src/payments/index.ts 2>/dev/null \
   && grep -qiE 'solana' src/payments/index.ts 2>/dev/null \
   && grep -qiE 'USDC' src/payments/index.ts 2>/dev/null; then
  pass "W7: x402 facilitator config supports Solana + USDC + PDA wallets"
else
  bad "W7: x402 facilitator config must support Solana + USDC + PDA wallets"
fi

# W8: a real unit test for the wallet-standard adapter passes.
TESTF=$(ls tests/wallet-standard*.test.ts 2>/dev/null | head -1)
if [ -n "$TESTF" ] && bun test "$TESTF" >/tmp/ws-test.out 2>&1; then
  pass "W8: $TESTF passes (consume wallet → PayHandler; unbrowse-default wallet)"
else
  bad "W8: no passing tests/wallet-standard*.test.ts"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "GREEN — native Wallet Standard (OWS) + lobster.cash wallet adapters shipped (SDK + frontend + docs)."
  exit 0
else
  echo "RED — wallet-adapter north star not yet settled."
  exit 1
fi
