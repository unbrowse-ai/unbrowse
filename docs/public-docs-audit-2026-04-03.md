# Public Docs Audit — 2026-04-03

Read when: deciding whether `docs.unbrowse.ai` is safe to treat as product truth.

## Scope

Compared:

- public docs site at `docs.unbrowse.ai` / `getfoundry.gitbook.io/unbrowse`
- repo-owned docs and FE metadata in this checkout
- shipped code paths for auth, payments, CLI/setup, and public web surfaces

## Bottom line

`docs.unbrowse.ai` is **not fully grounded** against the current repo state yet.

Two different doc strata are live:

1. newer whitepaper-companion/reference pages
2. older legacy GitBook pages that still rank in search and still describe a browser extension, abilities, FDRY, and pre-launch economics

Even the newer companion docs still mark parts of the x402/payment layer as `coming soon`, while the repo already ships payment gates, 402 terms, transaction routes, wallet plumbing, and payout/split handling.

## Code truth used for comparison

- x402 skill route + search gating:
  - [backend/src/middleware/x402-gate.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/src/middleware/x402-gate.ts)
  - [backend/tests/x402-skill-route.test.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/tests/x402-skill-route.test.ts)
  - [backend/tests/x402-search-route.test.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/tests/x402-search-route.test.ts)
- runtime payment handling:
  - [src/payments/index.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/src/payments/index.ts)
  - [src/client/index.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/src/client/index.ts)
  - [src/execution/index.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/src/execution/index.ts)
- wallet / payout / split plumbing:
  - [src/payments/cascade.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/src/payments/cascade.ts)
  - [backend/src/services/cascade.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/src/services/cascade.ts)
  - [backend/src/services/splits.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/src/services/splits.ts)
  - [backend/src/routes/transactions.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/src/routes/transactions.ts)
- current setup / registration flow:
  - [src/runtime/setup.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/src/runtime/setup.ts)
  - [src/client/index.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/src/client/index.ts)
- current public agent docs:
  - [SKILL.md](/Users/lekt9/.codex/worktrees/c99f/unbrowse/SKILL.md)
  - [frontend/public/llms-full.txt](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/public/llms-full.txt)

## Findings

### 1. New companion docs still understate shipped payments

Stale public pages:

- home: [Internal APIs Are All You Need](https://docs.unbrowse.ai/)
- companion explainer: [How It Works](https://getfoundry.gitbook.io/unbrowse/start-here/how-it-works)
- status audit: [Paper vs Product Status](https://docs.unbrowse.ai/reference/paper-vs-product)

Examples:

- home currently says readers should use `Coming Soon` for “route economy, x402, contributor payouts”
- `How It Works` says “billing and payouts do not”
- `Paper vs Product Status` says:
  - route-level pricing: coming soon
  - HTTP 402 handshake: coming soon
  - x402 settlement: coming soon
  - contributor payouts: coming soon

Repo reality:

- 402 terms are implemented and tested
- payment gating can be enabled/disabled with `PAYMENTS_ENABLED`
- staging/mainnet advertising is controlled with `X402_NETWORK_MODE`
- transaction routes exist
- wallet and split plumbing exist
- current payout policy is simplified, but not “absent”

Verdict: **materially stale**

### 2. Legacy GitBook pages are severely out of date

Stale public pages:

- [Getting Started](https://getfoundry.gitbook.io/unbrowse/for-indexers/getting-started)
- [Key Concepts (legacy)](https://getfoundry.gitbook.io/unbrowse/understanding-unbrowse/key-concepts)

These pages describe:

- browser extension install flow
- account creation flow with email/password / Google OAuth / Phantom
- “abilities” instead of skills
- FDRY token economics
- 19% execution-fee rewards
- pre-release “NO payments until full release”

Repo reality:

- product install is CLI-first: `npx unbrowse setup`
- OpenClaw path is `npx unbrowse-openclaw install --restart`
- public surfaces use `skill`, not `ability`
- repo ships x402/Lobster/Corbits payment plumbing, not FDRY token docs
- there is no browser-extension-based onboarding flow in this repo

Verdict: **obsolete**

### 3. Repo-owned FE metadata had stale docs/version signals

Fixed in this checkout:

- [frontend/src/app/layout.tsx](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/src/app/layout.tsx)
  - `softwareVersion` was hardcoded to `1.1.2`
- [frontend/public/llms.txt](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/public/llms.txt)
  - reader-facing docs links were still skewed toward `/skill.md`
- [frontend/src/components/docs-embed.tsx](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/src/components/docs-embed.tsx)
  - embed pointed at raw GitBook host instead of `docs.unbrowse.ai`

## Action buckets

### Must fix on the public docs site

1. update `Paper vs Product Status` economic-layer rows for shipped x402/payment pieces
2. update `How It Works` so it no longer says billing/payouts do not exist
3. either rewrite or remove the legacy `for-indexers` and `understanding-unbrowse` sections

### Safe wording until external docs are fixed

- call `docs.unbrowse.ai` the **public companion docs**
- do **not** call it canonical product truth
- keep repo docs / `SKILL.md` / `llms-full.txt` as the ground-truth contract

## Repo changes made during this audit

- corrected repo-owned wording from “canonical docs” to “public companion docs”
- updated FE `llms.txt` docs entry
- switched docs embed host to `https://docs.unbrowse.ai`
- fixed stale FE `softwareVersion` metadata
