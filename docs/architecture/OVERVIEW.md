# Unbrowse Architecture — System Overview

> Generated 2026-06-10 from the code at monorepo v8.3.0-preview.2. Every claim
> cites a real file path. Companion docs: [CLI.md](./CLI.md),
> [BACKEND.md](./BACKEND.md), [FRONTEND.md](./FRONTEND.md),
> [ACCEPTANCE-CRITERIA.md](./ACCEPTANCE-CRITERIA.md),
> [TEST-SPECS.md](./TEST-SPECS.md).

## What Unbrowse is

Unbrowse captures website interactions once and replays them as reusable API
routes ("skills") for agents. The system has three product surfaces plus a
shared cloud backend:

| Surface | Where | Tech | Serves |
|---|---|---|---|
| CLI / local engine | `src/`, distributed via `packages/skill` (npm `unbrowse`) | Bun-compiled single binary (`scripts/build-binaries.sh`, `src/single-binary.ts`) | Agents and developers on their own machines |
| MCP server | `src/mcp.ts` | JSON-RPC 2.0 over stdio, ~45 tools | MCP-compatible agent harnesses |
| Backend API | `backend/` | Cloudflare Workers + Hono (`backend/src/index.ts`), Neon Postgres, 7 KV namespaces (`backend/wrangler.toml`) | `https://beta-api.unbrowse.ai` |
| Web frontend | `frontend/` | Next.js 16 App Router on Cloudflare via open-next (`frontend/wrangler.jsonc`) | `https://unbrowse.ai` |
| Metrics dashboard | `../unbrowse-dashboard` (separate repo) | Next.js on Cloudflare Pages | `launch.unbrowse.ai` — public read-only adoption metrics from Unkey/GitHub/npm; does **not** talk to the backend |

## System map

```
┌─────────────────────────────┐
│ Agent harness (Claude, etc.)│
└──────┬──────────────┬───────┘
       │ MCP stdio    │ shell
┌──────▼──────┐ ┌─────▼─────┐     ┌────────────────────────┐
│ src/mcp.ts  │ │ src/cli.ts│     │ frontend/ (unbrowse.ai)│
│ 45 tools    │ │ 60+ cmds  │     │ registry, account,     │
└──────┬──────┘ └─────┬─────┘     │ wallet, billing UI     │
       │  in-process Fastify app  └──────────┬─────────────┘
┌──────▼──────────────▼─────────┐            │ fetch
│ Local engine                  │            │
│ capture/ → execution/ →       │   ┌────────▼─────────────┐
│ indexer/ → graph/ →           │   │ backend/ (CF Worker) │
│ intent-match.ts               ├──►│ beta-api.unbrowse.ai │
│ payments/ (x402 client rails) │   │ auth, keys, skills,  │
└───────────────────────────────┘   │ billing, x402, splits│
                                    └──┬────────┬──────────┘
                              Neon PG ◄┘        └► 7× CF KV
                              (accounts,           (keys, stripe cache,
                               telemetry)           sponsor ledger, skills,
                                                    sessions, traces, audit)
```

## Core data flows

### 1. Capture → publish → replay (the product loop)
1. **Capture** — `src/capture/index.ts` records a real browser interaction
   (with secret obfuscation in `src/capture/obfuscate.ts`, template holes in
   `src/capture/hole-template.ts`, credential binding in
   `src/capture/zk-bound-hole.ts` / `src/capture/wallet-bind.ts`).
2. **Index** — `src/indexer/` queues and indexes captured routes locally;
   `src/graph/` maintains the route cache and ranking.
3. **Publish** — `unbrowse publish` posts a skill manifest to
   `POST /v1/skills` (`backend/src/routes/skills.ts`), which validates,
   sanitizes residual secrets (`backend/src/services/marketplace.ts`), and
   indexes endpoints for search.
4. **Resolve & execute** — any agent resolves an intent
   (`src/intent-match.ts`, backend `/v1/search`) and replays the route
   (`src/execution/index.ts`), with anti-bot challenge handlers and proxy
   fallback (`src/execution/proxy-fetch.ts`,
   `src/execution/server-proxy-fallback.ts`).

### 2. Identity & auth
- Users sign in with **email magic links** (`backend/src/routes/auth.ts`,
  frontend `frontend/src/app/login/page.tsx`); there are no passwords.
- Auth artifacts are **API keys** (`ubr_<48-hex>`), SHA-256-hashed in KV
  (`backend/src/services/keys.ts`), validated by
  `backend/src/middleware/auth.ts` with timing-safe comparison, a Terms-of-
  Service version gate, and a global kill switch (`ALL_KEYS_REVOKED`).
- The CLI stores its key in `~/.unbrowse/config.json`
  (`src/client/index.ts`); the frontend stores it in `localStorage`
  (`frontend/src/lib/auth-context.tsx`).

### 3. Money (four rails, one ledger)
- **Stripe subscriptions** — checkout/portal/webhooks + usage metering and
  tier detection (`backend/src/services/stripe.ts`,
  `backend/src/routes/billing.ts`).
- **Crypto subscriptions** — monthly USDC plans through a short-lived intent
  record, activated by an x402 payment, cached under the same KV shape as
  Stripe so the read side treats both identically
  (`backend/src/services/crypto-sub.ts`).
- **Per-request x402** — HTTP 402 responses carry signed payment terms
  (USDC on Solana mainnet, plus Base); the client signs and retries
  (`src/payments/x402-fetch.ts`, server gate
  `backend/src/middleware/x402-gate.ts`, settlement splits
  `backend/src/services/flex.ts`).
- **Sponsored (free tier)** — the platform fronts the cost up to daily caps
  (`backend/src/middleware/sponsor.ts`), partly refilled from a fixed
  fraction of Stripe revenue (`backend/src/services/sponsor-pool.ts`).

**API key wraps the wallet**: a key can be bound to a funding source —
either an external wallet address or a prepaid credit budget — via
`POST /v1/account/keys/:keyId/funding` (`backend/src/routes/account.ts`).
Contributors who published before attaching a wallet are paid retroactively
when the binding appears (`backend/src/services/splits.ts`).

**Earnings**: each paid execution is split among roles — infrastructure
(platform), site owner (opt-in via DNS-verified domain claim), contributors
(delta-weighted), optional maintainer/treasury — summing to exactly 100%
(`backend/src/services/flex.ts`). A first-discoverer ledger additionally
rewards whoever first captured a route (the toll ledger/emit pair in
`src/` — fire-and-forget, never blocks the request path).

### 4. Wallets (pluggable, resolution order)
Client wallet resolution (`src/payments/x402-fetch.ts`, `src/cli-wallet.ts`):
1. **OWS (Open Wallet Standard)** vault at `~/.ows/wallets/*.json` — CAIP-2/
   CAIP-10 identifiers and a declarative policy engine
   (`src/payments/ows.ts`).
2. `LOBSTER_WALLET_ADDRESS` / `~/.lobster/agents.json` — lobster.cash CLI
   delegation (`src/payments/lobster-pay.ts`).
3. `AGENT_WALLET_ADDRESS` (+ provider) — bring-your-own Solana signer.
4. Privy embedded wallet (web sign-in; backend-side signing endpoint is
   declared but not yet live — see `src/payments/x402-fetch.ts`).
5. None → sponsored free tier or honest `x402_no_wallet` failure.

## Deploy topology
- **Backend**: Cloudflare Worker, envs production/staging/experiments/
  gate-staging (`backend/wrangler.toml`); cron every 6h for notification
  flush and buyback evaluation; Neon Postgres via `DATABASE_URL`.
- **Frontend**: Cloudflare Worker via open-next, zones `unbrowse.ai` and
  `www.unbrowse.ai` (`frontend/wrangler.jsonc`), R2 incremental cache.
- **CLI**: npm package `unbrowse` (`packages/skill/package.json`) and
  prebuilt binaries for darwin-arm64/x64, linux-arm64/x64, win-x64
  (`scripts/build-binaries.sh`).

## Where to go next
- Command/tool inventory and local engine internals → [CLI.md](./CLI.md)
- Route map, auth/key internals, billing internals, marketplace, data model
  → [BACKEND.md](./BACKEND.md)
- Pages, auth/session handling, billing & wallet UI → [FRONTEND.md](./FRONTEND.md)
- What "done" means per subsystem → [ACCEPTANCE-CRITERIA.md](./ACCEPTANCE-CRITERIA.md)
- Required unit tests and current coverage → [TEST-SPECS.md](./TEST-SPECS.md)
