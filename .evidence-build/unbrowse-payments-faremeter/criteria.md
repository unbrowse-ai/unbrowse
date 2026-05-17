# unbrowse-payments-faremeter acceptance criteria

Wave 2026-05-17. Mode: product. Scope: replace existing Flex path with
@faremeter/payment-solana, 50/50 platform/indexer-contributors split,
3-tier Stripe (Free/Pro/Metered) recurring credit grant, feature-flagged
rotation between PayAI exact + self-hosted Flex rails. No em dashes.
Every lane cites a source_id resolvable in evidence-2026-05-17.jsonl.

## Lanes

### L0 hygiene
PayAI Ed25519 private key was pasted in chat (PKCS#8 prefix confirms it
is a real secret). User rotates on PayAI before any PayAI traffic flows.
New key lives only in Worker secrets (`wrangler secret put PAYAI_API_KEY`),
never in a tracked file. Same for PAYMENT_RECIPIENT (public pubkey, but
lodged as a Worker secret + placeholder in .env.example).
- pass_when: leaked key revoked on PayAI; no PAYAI_API_KEY or platform-
  wallet private key appears in any tracked file under the repo;
  scripts/verify-no-secrets.sh greps clean.
- source_ids: code:hygiene#payai_key_leaked, code:env#payment_recipient_pubkey

### L1 faremeter_flex_50_50_split
Replace the body of `createFlexFacilitator(env)` (today self-hosted) with
`createFacilitatorHandler` from `@faremeter/payment-solana/flex/facilitator`,
driving `defaultSplits` per-skill from `SkillContributor[].cumulative_delta`
weighted 5000bps across the top 4 contributors (Flex MAX_SPLITS=5 minus
1 platform), with the remaining 5000bps going to PAYMENT_RECIPIENT. A
`mergeSplits()` pass collapses any duplicate recipient before submit
(program rejects FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT). Skills with zero
contributors collapse to 100% platform.
- pass_when: an authorized Flex payment on a skill with 3 known
  contributors settles on-chain with 4 split entries (1 platform + 3
  contributors) summing to 10000bps; settlement transaction has
  contributor wallets receiving USDC proportional to cumulative_delta;
  buildFlexPaymentTerms emits the splits array in the 402 envelope.
- source_ids: code:flex-route-helpers#handleFlexPaymentAuthorized,
  code:types.ts#SkillContributor, faremeter-docs:flex-overview,
  faremeter-docs:facilitator

### L2 rotation_flag_payai_vs_flex
The dual-scheme 402 envelope already advertises both Flex and exact-via-
PayAI today. Add a `PAYAI_ROTATION_BPS` worker secret (default 5000 = 50%)
that biases which scheme the 402 envelope advertises first (clients pick
the first match). A hash-bucket on `agent_id` keeps the rotation
deterministic per agent inside the bucket so latency comparisons hold.
- pass_when: setting PAYAI_ROTATION_BPS=0 makes 100% of 402 envelopes
  put Flex first; setting it to 10000 puts PayAI exact first; a given
  agent_id consistently lands in the same bucket across requests; a
  telemetry header X-Unbrowse-Rail-Hint=flex|payai records the choice
  so we can A/B fill rate + latency.
- source_ids: code:flex-route-helpers#handleFlexPaymentAuthorized,
  code:flex-route-helpers#sponsorAcceptsForPriceUsd

### L3 stripe_three_tier_subscription
Three tiers wired end-to-end: Free (0 grant, pay-as-you-go via x402),
Pro $20/mo (200k uc monthly credit auto-grant on subscription.created /
period rollover), Metered (Stripe Meter API, idempotency-keyed per
execution). New env: STRIPE_PRICE_PRO_MONTHLY (the flat price id),
STRIPE_PRICE_METERED (the metered price id), STRIPE_METER_EVENT_NAME
(default `unbrowse_execute`). processBillingEvent webhook handler
extended to: on subscription.created/renewed event of Pro -> grant
200k uc via the same path as `POST /v1/credits/grant`; on tier
downgrade -> clamp granted_uc to current period prorate. Metered tier
fires `billing.meterEvents.create({event_name, payload:{stripe_customer_id,
value:amount_uc}}, {idempotencyKey: \`${user_id}:${execution_id}\`})`
on every paid execute that lands on the metered rail.
- pass_when: subscribing to Pro grants the user 200k uc visible at
  GET /v1/credits/balance; the same user paying a paid skill debits
  it via the wave-1/2 debitKeyFunding path; downgrading clamps the
  balance; a Metered subscriber's 100 paid executes produce exactly
  100 Stripe meter events with unique idempotency keys (no double
  count on webhook retry).
- source_ids: code:stripe.ts#subscriptionAdmits,
  code:credits.ts#granted_uc_balance_uc,
  stripe-best-practices:meter-api

### L4 platform_recipient_pubkey
PAYMENT_RECIPIENT lodged as Worker secret with value
Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1. .env.example carries
the placeholder. `platformRecipientUsdcAta(env)` (referenced in
flex-route-helpers but not yet read in this wave) derives the USDC
associated token account from the base58 pubkey + USDC_MINT_MAINNET.
- pass_when: starting the worker without PAYMENT_RECIPIENT set surfaces
  an explicit error at boot rather than silently routing 100% to the
  default zero-address; with the secret set, a Flex 402 envelope's
  platform split entry resolves to the USDC ATA derived from the
  configured pubkey.
- source_ids: code:env#payment_recipient_pubkey,
  code:flex-route-helpers#sponsorAcceptsForPriceUsd

### L5 verification_real_no_mocks
Every lane above is covered by a bun test under
backend/tests/payments-faremeter-*.test.ts using the same no-mock
pattern as backend/tests/account-keys-vault-visibility.test.ts: real
Hono app, real services (Stripe in test mode via STRIPE_API_KEY=sk_test,
Faremeter via a real devnet RPC + a throwaway funded escrow), in-memory
KV transport only for the EmergentDB HTTP shim. No code paths mocked.
- pass_when: bun test backend/tests/payments-faremeter-*.test.ts passes
  green; backend tsc --noEmit -p backend/tsconfig.json stays clean;
  any pre-existing flake is verified pre-existing via stash-isolation.
- source_ids: code:stripe.ts#subscriptionAdmits,
  code:flex-route-helpers#handleFlexPaymentAuthorized

## Rubric

```yaml
lanes:
  - id: L0
    description: hygiene; leaked PayAI key rotated and not committed; PAYMENT_RECIPIENT in Worker secrets only
    source_ids: [code:hygiene#payai_key_leaked, code:env#payment_recipient_pubkey]
  - id: L1
    description: 50/50 platform + proportional indexer contributors via Faremeter Flex splits
    source_ids: [code:flex-route-helpers#handleFlexPaymentAuthorized, code:types.ts#SkillContributor, faremeter-docs:flex-overview, faremeter-docs:facilitator]
  - id: L2
    description: PAYAI_ROTATION_BPS feature flag, deterministic per-agent rail selection, telemetry header
    source_ids: [code:flex-route-helpers#handleFlexPaymentAuthorized, code:flex-route-helpers#sponsorAcceptsForPriceUsd]
  - id: L3
    description: Free/Pro/Metered three-tier Stripe, recurring credit grants on subscription events, Meter API on metered rail
    source_ids: [code:stripe.ts#subscriptionAdmits, code:credits.ts#granted_uc_balance_uc, stripe-best-practices:meter-api]
  - id: L4
    description: PAYMENT_RECIPIENT worker secret, boot-time validation, USDC ATA derivation
    source_ids: [code:env#payment_recipient_pubkey, code:flex-route-helpers#sponsorAcceptsForPriceUsd]
  - id: L5
    description: real-app no-mock tests + tsc clean; pre-existing fail isolation
    source_ids: [code:stripe.ts#subscriptionAdmits, code:flex-route-helpers#handleFlexPaymentAuthorized]
```
