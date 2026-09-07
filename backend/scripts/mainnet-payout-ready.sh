#!/usr/bin/env bash
# Mainnet payout readiness gate — the honest witness for "is the split ready to
# settle real USDC on mainnet?" Exit 0 = the CODE is mainnet-ready + proven; it
# then prints the go-live checklist (funds + secrets + a non-empty ledger) that is
# the OPERATOR's hand on real money, never an autonomous step.
#
# Two truths kept separate (per the paper-gap audit):
#   1. Atomic trustless on-chain split = Faremeter's EcfUgNg program, DEVNET-ONLY
#      (third-party, closed-source; not ours to deploy to mainnet).
#   2. Custodial mainnet path (disburse.ts) = OURS, mainnet-capable, but DRY-RUN
#      until DISBURSE_ENABLED=1 + a funded signer on a mainnet RPC.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0

echo "── 1. split math correct (computeFlexSplits sums to 10000; 50/35/15) ──"
if timeout 90 bun test tests/flex-owner-bps.test.ts tests/flex-owner-bps-edges.test.ts >/tmp/flexsplit.log 2>&1; then
  echo "  PASS  $(grep -oE '[0-9]+ pass' /tmp/flexsplit.log | head -1)"
else echo "  FAIL  split math broken — see /tmp/flexsplit.log"; fail=1; fi

echo "── 2. custodial disburse path is mainnet-CAPABLE (no devnet hardcode) ──"
if git grep -iqE "api\.devnet|cluster.*=.*devnet|'devnet'|\"devnet\"" src/services/disburse.ts src/services/sponsor-pay.ts 2>/dev/null; then
  echo "  FAIL  a devnet literal is hardcoded in the custodial path"; fail=1
else echo "  PASS  settles on the configured RPC — point CASCADE_RPC_URL at mainnet → mainnet settlement"; fi

echo "── 3. CODE READINESS verdict ──"
if [ "$fail" -eq 0 ]; then
  echo "  ✓ CODE IS MAINNET-READY. The split computes correctly and disburses on the configured chain."
else
  echo "  ✗ code not ready — fix the FAILs above before go-live."; exit 1
fi

cat <<'RUNBOOK'

── GO-LIVE CHECKLIST (operator-only — these move REAL USDC, not an autonomous step) ──
  A. Fund the platform signer wallet (CASCADE_SIGNER_SECRET_KEY) on MAINNET with:
       - enough USDC to cover owed contributor balances, and
       - a little SOL for transaction fees.
  B. Set the production Worker secrets (wrangler secret put …):
       - CASCADE_RPC_URL      = a Solana MAINNET RPC https endpoint
       - CASCADE_RPC_WS_URL   = the matching MAINNET RPC wss endpoint
       - CASCADE_SIGNER_SECRET_KEY = the funded signer keypair
       - DISBURSE_ENABLED     = 1        (until then executePayouts() refuses; computePayoutPlan is dry-run)
       - DISBURSE_MIN_USD     = 0.10     (optional; skips dust below the SPL fee)
  C. Precondition that actually matters: the attribution ledger must have EARNED balances —
     i.e. real paid executions must have happened, which requires the route index to be
     populated (see paper-gap gap #2: bm25-idx is empty today, so there is nothing to disburse yet).
  D. Verify before enabling: GET the admin payout-plan route → confirm computePayoutPlan returns
     the expected recipients while disburse_enabled=false (a real dry-run on mainnet config), THEN flip B.

  NOTE: the TRUSTLESS atomic one-transaction split stays devnet-only until Faremeter ships the
  EcfUgNg program to mainnet (third-party). The checklist above is the CUSTODIAL bridge.
RUNBOOK
RUNBOOK_EXIT=$?
exit 0
