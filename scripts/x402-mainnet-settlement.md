# x402 mainnet settlement runbook

The single reproducible recipe to settle one real mainnet USDC micropayment
through the deployed `/v1/llm` endpoint and capture the on-chain tx signature.
Everything except the funded spend is already built, deployed, and verified.

## State (as of 2026-05-30)

- **Backend fix is LIVE.** `beta-api.unbrowse.ai/v1/llm/:provider/messages` emits an
  x402-v2 compliant 402 (top-level `resource`, per-accept `extra.feePayer`).
  Verify: `curl -s -X POST https://beta-api.unbrowse.ai/v1/llm/nebius/messages -H 'content-type: application/json' -d '{"model":"kimi-k2.5","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'`
- **Client is committed + live-verified** (dry-run builds a real signed wire tx):
  `scripts/x402-pay-mainnet.mjs` (pure logic tested in `scripts/x402-pay-mainnet.test.mjs`).
- **Why not lobster:** the funded lobster wallet `9LQ241…` is a SMART wallet; the
  faremeter ToSpec exact flow needs a raw `partiallySignTransaction` over a
  noop-signer authority, which a smart wallet can't produce. Its send overhead
  (0.168 USDC) also exceeds its balance, so it can't bootstrap a plain keypair.
  → a **plain Ed25519 keypair** is required.

## The one remaining act (funded spend)

1. Fund the payer with USDC (no SOL needed — PayAI is the fee payer; receiving
   USDC creates the payer's token account):

   ```
   send ~$0.01 USDC (SPL, Solana mainnet) to:
   24e81CbxDq1WKY1bs2HCU8KcauVVdyNu3r8BurHqeVLD
   ```
   (secret for that keypair is at `/tmp/x402_payer.key`, mode 600; or set
   `UNBROWSE_PAYMENT_SECRET` to any funded plain keypair's base58 secret.)

2. Confirm the gate is ready:

   ```
   bun scripts/x402-payer-funded-gate.mjs   # exit 0 == READY
   ```

3. Settle the real micropayment and capture the signature:

   ```
   UNBROWSE_PAYMENT_SECRET_FILE=/tmp/x402_payer.key \
     bun scripts/x402-pay-mainnet.mjs https://beta-api.unbrowse.ai/v1/llm/nebius/messages
   ```
   On success: HTTP 200, and `PAYMENT-RESPONSE` decodes to the on-chain tx
   (`https://solscan.io/tx/<sig>`). That signature is the SHIPPED witness.

   Dry-run first (no spend) to re-verify the pipeline:
   `UNBROWSE_PAYMENT_SECRET_FILE=/tmp/x402_payer.key X402_DRY_RUN=1 bun scripts/x402-pay-mainnet.mjs`
