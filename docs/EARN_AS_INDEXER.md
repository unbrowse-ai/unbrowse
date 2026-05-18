## What you do

Run unbrowse against websites you actually use. The first time anyone, including you, hits a domain through `unbrowse resolve` + `unbrowse execute`, the underlying API is captured and a skill is published with you as the indexer (`backend/src/types.ts:409`, field `indexer_id`).

You do not have to mine, scrape, or seed. The capture is a side effect of normal use.

## What you earn

A share of every paid execute against the same skill, for as long as the skill exists.

- **Domain has a DNS-claimed site owner**: the indexer pool is 35% of each paid call (the 3500 bps lane left after `PLATFORM_BPS = 5000` and `OWNER_BPS = 1500`).
- **Domain has no DNS-claimed owner**: the indexer pool is 50% (`contributorPool = 10000 - PLATFORM_BPS = 5000` bps at `backend/src/services/flex.ts:66`).

The pool is divided across everyone in `skill.contributors[]` weighted by `cumulative_delta` (`backend/src/services/flex.ts:65-74`). If you were the only contributor, you get the whole pool. If three other agents have since refined the skill with new endpoints or repairs, you split with them by attribution weight, capped at four contributors (`FLEX_MAX_SPLITS - 1` at `backend/src/services/flex.ts:63`).

Settlement is on-chain. Your share lands in the same Faremeter Flex transaction as the platform's, in the same block, at no extra delay.

## Setup

1. Install the SDK or CLI.
   ```
   npm i @unbrowse/sdk
   ```
   The SDK spawns the local binary itself; no global install required. CLI users can `npx @unbrowse/sdk` or `unbrowse setup` for the interactive bootstrap.

2. Provision a payout wallet.
   ```
   npx @crossmint/lobster-cli setup
   ```
   Cited in `docs/HOW_UNBROWSE_PAYS.md` (the `/how-unbrowse-pays` page renders from this markdown via `frontend/src/lib/docs-renderer.ts`). Lobster owns the private key. unbrowse only sees the public Solana address you bind to your agent.

3. Bind the wallet to your agent. The magic-link flow at `backend/src/routes/auth.ts:53-172` creates the agent_id; the `account` page lets you set `wallet_address` on your `SkillContributor` record. Without a wallet bound, `computeFlexSplits` filters you out (`backend/src/services/flex.ts:58`, the `payable` filter).

## Where the math lives

- `computeFlexSplits` at `backend/src/services/flex.ts:54-87` is the pure arithmetic.
- `mergeSplits` at `backend/src/services/flex.ts:98-113` collapses duplicate recipients so the Flex program does not reject the authorization.
- `SkillContributor` schema at `backend/src/types.ts:516-531` defines the attribution row (`agent_id`, `wallet_address`, `cumulative_delta`).
- Rail selection at `backend/src/services/rail-rotation.ts` decides Flex vs PayAI per call; only Flex carries splits.

## How to see your earnings

The account dashboard at `/account` reads your contribution rows and accumulated balance. The magic-link login at `frontend/src/lib/auth-context.tsx:107-141` is the entry point.

CLI users can also query directly:
```
curl https://beta-api.unbrowse.ai/v1/account/me \
  -H "Authorization: Bearer <YOUR_API_KEY>"
```

The response includes the contributor rows that name your `agent_id`.

## One example call

You ask unbrowse to read a Hacker News post. Nobody has indexed `news.ycombinator.com` yet.

1. Agent calls `unbrowse_resolve --intent "read HN post" --url https://news.ycombinator.com/item?id=...`.
2. Resolve has no cached match. unbrowse opens a browse session, navigates, captures the underlying API (the `/item` JSON endpoint or the SSR page extraction).
3. Agent calls `unbrowse_execute` against the discovered endpoint. The execute succeeds; the skill is published with `indexer_id = <your agent_id>` and a `SkillContributor` row for your wallet.
4. A week later, another agent calls the same skill to read a different HN item. x402 fires. Flex settles with the splits:
   - 5000 bps to the platform USDC ATA.
   - 1500 bps to the site owner if `news.ycombinator.com` has DNS-claimed a wallet, else 0.
   - The remaining 3500 or 5000 bps to your wallet (and any later contributors).
5. The settlement transaction lands on Solana. Your balance updates the moment the block confirms.

There is no claim step, no withdrawal, no batch. You earn while you sleep, on calls made by agents you have never met.
