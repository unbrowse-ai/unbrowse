## What this document is

This page explains how money moves through unbrowse on every paid call. The math, the splits, the wallet ownership, and the rails. Every claim cites a file and line in the codebase.

## The 50/30/20 split

Every paid `unbrowse execute` settles on-chain through a Faremeter Flex authorization with up to five recipients in one transaction.

- **Platform: 50%.** `PLATFORM_BPS = 5000` at `backend/src/services/flex.ts:39`. This share funds the substrate (resolve, marketplace, facilitator). Can be overridden per deployment via the `FLEX_PLATFORM_BPS` env var, range 0 to 10000.
- **Site owner: 20%.** `OWNER_BPS = 2000` (added beside `PLATFORM_BPS` in `backend/src/services/flex.ts:39`). Routed only when the domain has been DNS-claimed and the skill carries `owner_compensation_opt_in === true` (`backend/src/types.ts:437`) together with a verified `owner_wallet_usdc_ata`.
- **Indexer pool: 30%.** The remaining 3000 bps when a site owner is bound. Split across `skill.contributors[]` weighted by `cumulative_delta` (`backend/src/services/flex.ts:65-74`), then deduped with `mergeSplits` (`backend/src/services/flex.ts:98-113`) because the Flex on-chain program rejects duplicate recipients.
- **No site owner claimed: 50% platform, 50% indexer pool.** When `owner_compensation_opt_in` is false or no DNS claim exists, the carve falls through to the original split. `contributorPool = 10000 - PLATFORM_BPS = 9000` bps (`backend/src/services/flex.ts:66`).

The split is capped at `FLEX_MAX_SPLITS = 5` (`backend/src/services/flex.ts:40`). The top four contributors by `cumulative_delta` take the contributor pool; everyone else attributes through future calls.

## Indexer earnings

When you use unbrowse to call a website nobody has indexed yet, the act of resolving and executing CAPTURES the underlying API. You become the indexer of that skill, recorded as `indexer_id` on the `SkillManifest` (`backend/src/types.ts:409`).

From that point forward, every paid `execute` against the same skill, by any agent, routes you a share. Your wallet address lives on the `SkillContributor` row that the publish handler attaches (`backend/src/types.ts:516-531`). At settlement, `computeFlexSplits` reads `skill.contributors`, filters entries with a non-empty `wallet_address`, weights by `cumulative_delta`, and produces the Flex split array (`backend/src/services/flex.ts:54-87`).

Payouts land in the same on-chain transaction as the platform's. There is no escrow, no nightly batch, no opt-in to be paid.

## Site owner earnings

If you run the domain that unbrowse is indexing, you can claim 20% of every paid call to that domain's skills.

The claim is a DNS-TXT record. The verifier resolves `_unbrowse-claim.<apex>` through two independent DoH providers (Cloudflare and Google), both must return a TXT whose value is `unbrowse-claim=<challenge>;wallet=<your-wallet>`. The contract is described in `.claude/firmament-step2.md` lines 86-176 and implemented under `backend/src/routes/claim.ts` and `backend/src/services/domain-claim.ts`.

The skill must also carry `owner_compensation_opt_in === true` (`backend/src/types.ts:437`). The publish handler sets this when the indexer or owner explicitly opts in. The OWNER_BPS lane fires only when both conditions hold: the opt-in flag is true AND `owner_wallet_usdc_ata` resolves from the `domain-wallet:<domain>` KV binding.

See `unbrowse/docs/CLAIM_YOUR_DOMAIN.md` for the step-by-step.

## Wallets stay with lobster.cash

The substrate never holds private keys. The frontend recommends lobster.cash as the payout wallet (`frontend/src/app/how-unbrowse-pays/page.tsx:205-227`): `npx @crossmint/lobster-cli setup` provisions a Solana account, lobster signs, unbrowse only declares intent, amount, recipient, and memo. If you want a different signer, the payment terms are plain x402; any wallet that can sign a Faremeter Flex authorization works.

## x402 is the main rail

Settlement runs on the x402 standard. unbrowse rotates between two facilitators per request:

- **Flex** (default). Self-hosted Faremeter facilitator with native splits. The 50/30/20 math above runs on Flex. Selection logic at `backend/src/services/rail-rotation.ts`.
- **PayAI exact** (rotation fallback). Single-recipient. Does NOT carry splits, so when PayAI wins the rotation the contributor and owner pools settle off-rail (deferred until a Flex-rail transaction). `PAYAI_ROTATION_BPS` env (default 5000) controls the weight; the hash of `agent_id` decides which rail's accept entry comes first in the 402 envelope.

Stripe optionally wraps either rail for fiat-billed customers, but the underlying on-chain split is unchanged.

## No account required to pay

Agents pay per call. The x402 response carries the price, recipient, and memo. The caller signs and the facilitator settles. There is no signup, no API key gate on the pay path.

Accounts exist for one reason: to accumulate and read earnings. The magic-link flow at `backend/src/routes/auth.ts:53-172` issues an API key and an agent_id; the agent_id is what we attribute contributions to. You can use unbrowse without ever creating one; you just can't see a balance until you do.

## What this is not

- Not a custodial wallet. Funds never sit in an unbrowse account.
- Not a marketplace fee on capture. We charge on execute, not on publish.
- Not a subscription. There is no monthly plan; every paid call is its own settlement.
- Not a cross-chain bridge. Solana USDC only; the on-chain mint is hardcoded at `backend/src/services/flex.ts:44`.
