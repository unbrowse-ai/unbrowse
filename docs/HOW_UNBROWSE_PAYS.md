## What this document is

This page explains how money moves through unbrowse on every paid call. The math, the splits, the wallet ownership, and the rails. Every claim cites a file and line in the codebase.

## Web2 subscription path

For users who never want to touch crypto, unbrowse exposes a Stripe-backed subscription that hides x402 entirely:

1. The user opens the URL returned by `POST /v1/account/billing-subscribe-url` (`backend/src/routes/account.ts`), pays with a card via Stripe Checkout, and lands back on the configured success URL.
2. Stripe's webhook (`POST /v1/billing/webhook`) drives `syncStripeDataToUserKV` (`backend/src/services/stripe.ts:226`), which writes the canonical `STRIPE_SUB_CACHE` to `stripe:customer:<customer_id>` in KV.
3. On every paid `execute`, when the worker is started with `UNBROWSE_BILLING_ENABLED=1` the sponsor middleware (`backend/src/middleware/sponsor.ts:maybeSponsor`) consults `subscriptionAdmits` BEFORE the x402 platform-sponsor wallet check. A subscribed user with quota is admitted; usage is recorded against the Stripe-tracked balance via `recordUsage`; a sponsor-ledger row tagged `payment_method: "stripe"` is written for audit. The agent never sees a 402.
4. Status is observable via `GET /v1/account/billing-status` — `{ subscription_active, plan_name, monthly_limit_usd, consumed_usd, remaining_usd, renewal_date, payment_method_present, auto_refill_enabled }`. The absent-subscription case returns `{ subscription_active: false, ...nulls }`, never 404.
5. The user manages cards, invoices, and cancellation via the Stripe customer-portal URL from `POST /v1/account/billing-portal-url`.

The gate is reversible: `UNBROWSE_BILLING_ENABLED` unset → the Stripe lane is a no-op and every paid call rides the x402 path documented below. On a worker where `STRIPE_SECRET_KEY` is also unset, the three account routes soft-fail with `503 billing_not_configured` rather than crash.

Non-subscribers (or subscribers over quota with no auto-refill) continue to use the x402 / Flex / sponsor rails described next.


## The 50/35/15 split

Every paid `unbrowse execute` settles on-chain through a Faremeter Flex authorization with up to five recipients in one transaction.

- **Platform: 50%.** `PLATFORM_BPS = 5000` at `backend/src/services/flex.ts:39`. This share funds the substrate (resolve, marketplace, facilitator). Can be overridden per deployment via the `FLEX_PLATFORM_BPS` env var, range 0 to 10000.
- **Site owner: 15%.** `OWNER_BPS = 1500` (added beside `PLATFORM_BPS` in `backend/src/services/flex.ts`). Routed only when the domain has been DNS-claimed and the skill carries `owner_compensation_opt_in === true` (`backend/src/types.ts:437`) together with a verified `owner_wallet_usdc_ata`.
- **Indexer pool: 35%.** The remaining 3500 bps when a site owner is bound. Split across `skill.contributors[]` weighted by `cumulative_delta` (`backend/src/services/flex.ts:65-74`), then deduped with `mergeSplits` (`backend/src/services/flex.ts:98-113`) because the Flex on-chain program rejects duplicate recipients.
- **No site owner claimed: 50% platform, 50% indexer pool.** When `owner_compensation_opt_in` is false or no DNS claim exists, the carve falls through. `contributorPool = 10000 - PLATFORM_BPS = 5000` bps (`backend/src/services/flex.ts:66`).

The split is capped at `FLEX_MAX_SPLITS = 5` (`backend/src/services/flex.ts:40`). The top four contributors by `cumulative_delta` take the contributor pool when unclaimed; the top three when a site-owner lane is active.

## Per-skill markup (5 to 80 percent)

Every `SkillManifest` carries an optional `markup_bps` field (Pontus / ABK Labs brief 2026-05-21: "5-80% markup potential on Flex"). When set, it overrides the default `PLATFORM_BPS = 5000` for that specific skill's settlements. The clamp is enforced server-side at `backend/src/services/flex.ts:48-49` (`MARKUP_BPS_MIN = 500`, `MARKUP_BPS_MAX = 8000`); values outside the range snap to the nearest bound.

What the agent sees: `markup_bps` shifts the platform's bps share, NOT the owner or indexer math. The owner lane stays at `OWNER_BPS = 1500` when DNS-claimed; the contributor pool absorbs the residual.

Concrete examples (owner claimed, default OWNER_BPS=1500):

- `markup_bps = 500` (the floor, 5% platform) -> 5% platform, 15% owner, 80% indexers.
- `markup_bps = 5000` (the unset default, 50% platform) -> 50% platform, 15% owner, 35% indexers. This is the canonical case above.
- `markup_bps = 8000` (the ceiling, 80% platform) -> 80% platform, 15% owner, 5% indexers.

When no owner is claimed, the residual flows entirely into the contributor pool, so a `markup_bps = 500` skill gives indexers 95% of every paid call. A premium-content skill that wants to fund the platform aggressively can dial up to 8000.

The field is set at publish time (`PublishSkillInput.markup_bps` on the SDK and CLI) and is per-skill, not per-call. Skills with no value continue to settle at the documented 50/35/15.


## Indexer earnings

When you use unbrowse to call a website nobody has indexed yet, the act of resolving and executing CAPTURES the underlying API. You become the indexer of that skill, recorded as `indexer_id` on the `SkillManifest` (`backend/src/types.ts:409`).

From that point forward, every paid `execute` against the same skill, by any agent, routes you a share. Your wallet address lives on the `SkillContributor` row that the publish handler attaches (`backend/src/types.ts:516-531`). At settlement, `computeFlexSplits` reads `skill.contributors`, filters entries with a non-empty `wallet_address`, weights by `cumulative_delta`, and produces the Flex split array (`backend/src/services/flex.ts:54-87`).

Payouts land in the same on-chain transaction as the platform's. There is no escrow, no nightly batch, no opt-in to be paid.

## Site owner earnings

If you run the domain that unbrowse is indexing, you can claim 15% of every paid call to that domain's skills.

The claim is a DNS-TXT record. The verifier resolves `_unbrowse-claim.<apex>` through two independent DoH providers (Cloudflare and Google), both must return a TXT whose value is `unbrowse-claim=<challenge>;wallet=<your-wallet>`. The contract is described in `.claude/firmament-step2.md` lines 86-176 and implemented under `backend/src/routes/claim.ts` and `backend/src/services/domain-claim.ts`.

The skill must also carry `owner_compensation_opt_in === true` (`backend/src/types.ts:437`). The publish handler sets this when the indexer or owner explicitly opts in. The OWNER_BPS lane fires only when both conditions hold: the opt-in flag is true AND `owner_wallet_usdc_ata` resolves from the `domain-wallet:<domain>` KV binding.

See `docs/CLAIM_YOUR_DOMAIN.md` for the step-by-step.

## Payment provider choice (Pay signer / lobster.cash / Privy / external)

The substrate never holds private keys; you bind a signer at `unbrowse setup`. As of 2026-05-21 there are four supported providers selectable from the CLI prompt and the `/account` web page (`POST /v1/account/payment-provider` persists the choice; `backend/src/services/flex.ts` honours it on dispatch).

- **Pay signer** -- TouchID-backed signer, USDC settlement via x402 MPP / search_catalog. The thinnest path for laptop agents; the wallet lives in the macOS keychain. The CLI bridge is `src/payments/paysh-pay.ts` (shells to `pay curl <url>` on each settle).
- **lobster.cash** -- Crossmint-backed credit-card -> virtual-card -> Solana funnel. The recommended path for non-technical users; subscription billing tops up the wallet automatically. `npx @crossmint/lobster-cli setup` provisions the account.
- **Privy embedded** -- Solana wallet provisioned in-browser via Privy. Bound to the user's `agent.wallet_address` after `verifyPrivyAuthToken` succeeds (`backend/src/services/privy.ts`). The right answer when the agent runs as a web app and the user signs in with email or OAuth instead of installing a CLI.
- **External wallet** -- bring your own Solana signer. The substrate emits an x402 envelope; any wallet that can sign a Faremeter Flex authorization works.

The choice is reversible: `unbrowse setup` re-runs the prompt, or POST a new provider to `/v1/account/payment-provider`. The selected provider gates the runtime dispatch path; the on-chain split math (above) is identical across providers.

## Wallets stay with lobster.cash

The substrate never holds private keys. The frontend recommends lobster.cash as the payout wallet (the live `/how-unbrowse-pays` page renders from `docs/HOW_UNBROWSE_PAYS.md` via `frontend/src/lib/docs-renderer.ts`): `npx @crossmint/lobster-cli setup` provisions a Solana account, lobster signs, unbrowse only declares intent, amount, recipient, and memo. If you want a different signer, the payment terms are plain x402; any wallet that can sign a Faremeter Flex authorization works.

## x402 is the main rail

Settlement runs on the x402 standard. unbrowse rotates between two facilitators per request:

- **Flex** (default). Self-hosted Faremeter facilitator with native splits. The 50/35/15 math above runs on Flex. Selection logic at `backend/src/services/rail-rotation.ts`.
- **PayAI exact** (rotation fallback). Single-recipient. Does NOT carry splits, so when PayAI wins the rotation the contributor and owner pools settle off-rail (deferred until a Flex-rail transaction). `PAYAI_ROTATION_BPS` env (default 5000) controls the weight; the hash of `agent_id` decides which rail's accept entry comes first in the 402 envelope.

Stripe optionally wraps either rail for fiat-billed customers, but the underlying on-chain split is unchanged.

## No account required to pay

Agents pay per call. The x402 response carries the price, recipient, and memo. The caller signs and the facilitator settles. There is no signup, no API key gate on the pay path.

Accounts exist for one reason: to accumulate and read earnings. The magic-link flow at `backend/src/routes/auth.ts:53-172` issues an API key and an agent_id; the agent_id is what we attribute contributions to. You can use unbrowse without ever creating one; you just can't see a balance until you do.

## Settlement cycle

Each paid execute writes one row to `sponsor:ledger:<id>` carrying the agent, the skill, `amount_uc` (µ¢), `creator_wallet`, and `settled_at`. Those rows are the source-of-truth for the dashboards (`GET /v1/analytics/payments` reads them directly: platform cut, sponsor recoup, creator payouts are all derived from the ledger, not stamped separately).

Operators roll the unsettled rows into a batch via two admin routes:

1. `POST /v1/admin/aggregate-settlement?since=&until=&dry_run=` — walks `sponsor:ledger:*`, filters to rows whose `batch_settled_tx` is absent, groups them by `skill_id`, looks up each `SkillManifest`, runs `computeFlexSplits` to derive the recipient layout (platform / owner / contributor), and writes a `settlement:ledger:<batch_id>` row in `status:"pending"`. `dry_run=1` still persists the batch — it is the source-of-truth that `execute-settlement` reads from — but lets the operator inspect the recipients before submitting.
2. `POST /v1/admin/execute-settlement` body `{batch_id, dry_run?}` — reads the batch, normalises the per-recipient µ¢ amounts into Flex bps (re-normalised to sum to exactly 10000), assembles the on-chain authorization, and either returns it for inspection (`dry_run:true`) or signs and submits it; each source row is stamped with `batch_settled_tx + batch_settled_at` so it does not replay.

Batch state is readable any time via `GET /v1/admin/settlement/:batch_id` — returns the pending or executed `SettlementBatch` row from KV, or 404 when absent. The shape includes `recipients[]` (with the `owner_lane` flag set on the verified-domain entry), `tx_signature` (once executed), `total_amount_uc`, and `source_ledger_ids[]`.

### Domain opt-out propagation

A verified domain owner can opt out via the DNS-TXT takedown flow (`unbrowse-takedown=<challenge>`). The verify endpoint writes a persistent `domain-optout:<domain>` record to KV. Aggregation reads that key for every skill it groups; when present, it coerces `owner_compensation_opt_in` to `false` at compute time and the 1500 bps owner lane rolls back into the contributor + platform pool. Opt-out is a binary, one-way signal — the owner can re-enable compensation by re-running the claim flow.


## What this is not

- Not a custodial wallet. Funds never sit in an unbrowse account.
- Not a marketplace fee on capture. We charge on execute, not on publish.
- Not a subscription. There is no monthly plan; every paid call is its own settlement.
- Not a cross-chain bridge. Solana USDC only; the on-chain mint is hardcoded at `backend/src/services/flex.ts:44`.
