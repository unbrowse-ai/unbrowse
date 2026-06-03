#!/usr/bin/env bash
# billing-honesty-gate — the frontend payment surfaces (billing + account) must
# describe the REAL model (per-request x402 cut, fund a wallet) and must NOT *sell*
# a Stripe subscription. TASTE seal: no UI that lies about the payment model ships.
# Matches subscription-SELLING signals (buttons/routes/plan copy), not the mere
# word "subscription" (which appears in honest negations like "not by subscription").
set -uo pipefail
cd "$(dirname "$0")/.."
B=frontend/src/app/billing/page.tsx
[ -f "$B" ] || { echo "[billing-gate] no billing page"; exit 1; }
grep -qiE "per request|per-request|x402" "$B" || { echo "[billing-gate] FAIL — billing page lacks per-request/x402 model"; exit 1; }
SELL='/billing/checkout|/billing/portal|startCheckout|Manage subscription|Monthly quota|\$[0-9]+/mo|Stripe Meter|Stripe-tier|Subscribe to|tier picker'
fail=0
for f in frontend/src/app/billing/page.tsx frontend/src/app/account/page.tsx; do
  if grep -qiE "$SELL" "$f" 2>/dev/null; then
    echo "[billing-gate] FAIL — $f still sells a subscription/Stripe:"; grep -niE "$SELL" "$f" | head -4; fail=1
  fi
done
[ "$fail" -eq 0 ] && { echo "[billing-gate] PASS — payment surfaces describe per-request x402, no subscription selling."; exit 0; }
exit 1
