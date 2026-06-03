# Fare Splits

How a paid call to an Unbrowse skill divides into three on-chain shares.

## The three lanes

When an agent calls a paid skill via `unbrowse execute`, the platform's facilitator signs a Faremeter Flex authorization that distributes the price across up to three recipients atomically. The math lives in `backend/src/services/flex.ts:computeFlexSplits`.

| Lane | Share | When it fires |
|---|---|---|
| **Platform** (`PLATFORM_BPS = 5000`) | 50% | Always |
| **Site owner** (`OWNER_BPS = 1500`) | 15% | Only when the skill carries `owner_compensation_opt_in === true` and a verified `owner_wallet_usdc_ata` (see [Claiming a Website](claiming-a-website.md)) |
| **Contributors** (the remainder) | 35% when owner is active; 50% otherwise | When the skill has a non-empty `contributors[]` with at least one `wallet_address` |

The three lanes always sum to exactly 10000 basis points (100%). The Flex on-chain program rejects authorizations that do not sum to 10000 (`FLEX_ERROR__SPLIT_SUM_INVALID`), so the computation is checked at compile-time-of-trust in the tests at `backend/tests/flex-owner-bps.test.ts` and `backend/tests/flex-owner-bps-edges.test.ts`.

## Why three lanes instead of two

The pre-claim shape was 50/50 (platform / contributor pool). When a site owner publishes their canonical API or proves ownership via DNS-TXT, they have done work that did not previously exist: surfacing a stable contract for agents to consume. The 15% lane lets that work get paid while preserving a 35% indexer share, the largest single slice for the people doing the discovery and maintenance work.

If the domain is never claimed, indexers absorb the would-be owner share automatically (the contributor pool grows to 50%). No domain has to pay for a missing owner; the math degrades gracefully.

## Contributor sub-splits

Within the contributor pool, individual recipients are weighted by `cumulative_delta` on each `SkillContributor` record:

```text
contributor_share_i = max(cumulative_delta_i, 0.01) / sum(max(cumulative_delta_j, 0.01))
                    * contributor_pool_bps
```

The top `FLEX_MAX_SPLITS - 1` (or `- 2` when the owner lane is active) by `cumulative_delta` get a slot; the rest are dropped from this settlement (they accrue weight for future calls). The on-chain Flex program caps at 5 split recipients per authorization, so the caller of `unbrowse setup` cannot be the 99th contributor and silently lose all attribution.

## What happens when there are no eligible contributors

- **No payable contributors AND no active owner:** `computeFlexSplits` returns an empty array. The caller (`backend/src/services/flex-payment-terms.ts:99`) falls back to a single-recipient transfer to the platform. The price still settles; no contributor earnings, no owner earnings.
- **No payable contributors but owner IS active:** the helper folds the unallocated contributor pool back into the platform recipient so the on-chain authorization still sums to exactly 10000 bps. The owner still gets their 1500 bps.

These edge cases are explicitly pinned in `backend/tests/flex-owner-bps-edges.test.ts` so any future re-tune cannot silently leak basis points.

## When the lanes change

The constants `PLATFORM_BPS` and `OWNER_BPS` are policy. They live in `backend/src/services/flex.ts:39-49` and are the only source of truth for the on-chain settlement math. Doc, dashboard, and frontend copy should never hard-code numbers that disagree with these constants; if a re-tune lands, the docs move with the constants.

The current numbers (50/15/35 when claimed, 50/50 when not) are the live constants as of this writing. They have shipped on origin/main and any earlier prose that called 50/20/30 the live value is stale. If you see a number in production that disagrees with this doc, the constants are still the truth, not the prose.

## Settlement rail and timing

- **Rail:** x402 over Solana, USDC, using `@faremeter/flex`.
- **Cadence:** each paid execute signs a Flex authorization off-chain; the platform's facilitator holds the authorization in memory, then submits a batched on-chain settlement after the refund window closes. Distribution is atomic per the signed splits.
- **Visibility:** `unbrowse stats --earnings` (CLI), or `GET /v1/stats/indexer/:id/ledger`, `GET /v1/account`, `GET /v1/analytics/payments` (HTTP).

## Related

- [Claiming a Website](claiming-a-website.md) — how a site owner verifies DNS ownership and earns the 15% lane
- [Rewards & Economics (SDK)](../sdk/rewards-and-economics.md) — operator-facing pricing + payout details
