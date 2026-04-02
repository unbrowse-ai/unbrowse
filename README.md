# Unbrowse

Turn any website into a reusable API interface for agents. Unbrowse captures network traffic, reverse-engineers the real endpoints underneath the UI, and stores what it learns in a shared marketplace so the next agent can reuse it instantly.

One agent learns a site once. Every later agent gets the fast path.

Unbrowse is a drop-in browser for agents: same browser-shaped job in the stack, but with route learning, reuse, and browser fallback built in.

> Security note: capture and execution stay local by default. Credentials stay on your machine. Learned API contracts are published to the shared marketplace only after capture. See [SKILL.md](./SKILL.md) for the full agent-facing API reference and tool-policy guidance.

## Quick start

```bash
# Fastest full setup
npx unbrowse setup
```

`npx unbrowse setup` downloads the CLI on demand, verifies the bundled Kuri runtime, registers the Open Code `/unbrowse` command when Open Code is detected, and starts the local server.

For daily use:

```bash
npm install -g unbrowse
unbrowse setup
```

If your agent host uses skills:

```bash
npx skills add unbrowse-ai/unbrowse
```

## Upgrading

Unbrowse no longer self-updates at runtime. If you already have Unbrowse installed, upgrade to the latest version after each release or the new flow may not work on your machine.

If you installed the CLI globally:

```bash
npm install -g unbrowse@latest
unbrowse setup
```

If your agent host uses skills, rerun its skill install/update command too:

```bash
npx skills add unbrowse-ai/unbrowse
```

Need help or want release updates? Join the Discord: [discord.gg/VWugEeFNsG](https://discord.gg/VWugEeFNsG)

Every CLI command auto-starts the local server on `http://localhost:6969` by default. Override with `UNBROWSE_URL`, `PORT`, or `HOST`. On first startup it auto-registers as an agent with the marketplace and caches credentials in `~/.unbrowse/config.json`.

Works with Claude Code, Open Code, Cursor, Codex, Windsurf, and any agent host that can call a local CLI or skill.

## Repo checkout

For monorepo development, initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

This pulls the tracked Kuri source into `submodules/kuri` from [justrach/kuri](https://github.com/justrach/kuri.git). `npm pack --workspace packages/skill` then bundles platform-specific Kuri binaries from that source into the published CLI package.

## Docs

Long-form docs live under [`docs/`](./docs/), including the restored whitepaper companion set:

- [`docs/whitepaper/README.md`](./docs/whitepaper/README.md) - public companion index
- [`docs/whitepaper/for-technical-readers.md`](./docs/whitepaper/for-technical-readers.md) - architecture, eval truth, and product boundary
- [`docs/whitepaper/for-investors.md`](./docs/whitepaper/for-investors.md) - market and business framing
- [`docs/analytics-api.md`](./docs/analytics-api.md) - canonical investor/product analytics surface

## What setup does

- Checks local prerequisites for the npm/npx flow.
- Verifies the bundled Kuri binary, or builds it from the vendored Kuri source when working from repo source with Zig installed.
- Registers the Open Code `/unbrowse` command when Open Code is present.
- Starts the local Unbrowse server unless `--no-start` is passed.

## Common commands

```bash
unbrowse health
unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty
unbrowse login --url "https://calendar.google.com"
unbrowse skills
unbrowse search --intent "get stock prices"
```

## Demo notes

- First-time capture/indexing on a site can take 20-80 seconds. That is the slow path; repeats should be much faster.
- For website tasks, keep the agent on Unbrowse instead of letting it drift into generic web search or ad hoc `curl`.
- Reddit is still a harder target than most sites because of anti-bot protections. Prefer canonical `.json` routes when available.

## How it works

Unbrowse has a six-layer pipeline that turns any website into a reusable API:

### 1. Passive capture

When an agent navigates through Unbrowse, every network API call is intercepted and recorded with response bodies -- automatically, with no explicit capture step. The JS interceptor is injected via `Page.addScriptToEvaluateOnNewDocument` so early SPA hydration calls are never missed. Chrome extension webRequest data supplements the interceptor for service worker traffic.

### 2. Background indexing

Captured traffic is reverse-engineered into API endpoints in the background without blocking the agent. The indexer extracts endpoints, builds an operation graph, and writes results to a local skill cache. The heavy work (marketplace validation and publishing) runs asynchronously -- the agent gets its result immediately.

### 3. Cache-first resolution

When an agent asks for something, Unbrowse checks seven layers before touching the network:

1. In-memory result cache (exact match)
2. Route cache (persisted, 24h TTL)
3. Domain skill cache (persisted, 7d TTL)
4. Local skill snapshots (disk scan)
5. Marketplace semantic search (remote)
6. First-pass browser action (lightweight 8s attempt)
7. Live capture (full browser, last resort)

Second visits to any site resolve from local cache in <200ms -- no browser launch, no marketplace call.

### 4. Browser replacement API

Agents can use Unbrowse as a drop-in replacement for Playwright or Puppeteer:

```typescript
import { Browser } from "unbrowse";

const browser = await Browser.launch();
const page = await browser.newPage();
const response = await page.goto("https://example.com/search?q=test");
const data = await response.json(); // structured skill data, or page HTML
await browser.close();
```

`page.goto()` resolves from the skill cache first. If a cached skill exists, no browser tab opens -- the agent gets structured data directly. On cache miss, it navigates via kuri and captures traffic transparently. UI actions (`click`, `fill`, `waitForSelector`) use kuri's evaluate fallback.

### 5. Endpoint graph

Endpoints are connected in a dependency graph with typed edges: parent/child (list -> detail), pagination (cursor chains), and auth dependencies. When an agent resolves a list endpoint, related detail endpoints are prefetched in the same round-trip. The `available_endpoints` in the resolve response reflects graph reachability given the agent's current bindings.

### 6. Marketplace and payments

Every learned skill is published to the shared marketplace. Skills captured by agent A are discoverable by agent B on a different machine via semantic vector search. Errors agents encounter automatically file GitHub issues with full repro context (intent, URL, endpoint ID, error, kuri version).

Skill creators can set a price per execution. Agents with funded wallets pay for paid skills; free skills remain free. Creator payout wallets are synced from agent registration/runtime wallet state. Today paid skills route to a single payout wallet: the current majority contributor, with first-contributor winning ties. That winner wallet must be Solana mainnet USDC-ready (have a USDC token account) or Corbits settlement will fail even if the x402 proof is otherwise valid.

For Cascade split provisioning during publish, set either:

- `UNBROWSE_CASCADE_SPLIT_ADDRESS` or `UNBROWSE_CASCADE_SPLIT_CONFIG` to pin an already-created split config address
- or `UNBROWSE_CASCADE_PLATFORM_WALLET`, `UNBROWSE_CASCADE_SIGNER_SECRET_KEY`, `UNBROWSE_CASCADE_RPC_URL`, and `UNBROWSE_CASCADE_RPC_WS_URL` to auto-create/update the split via `@cascade-fyi/splits-sdk`

Worker payment gating is controlled by `PAYMENTS_ENABLED`. Set it to `false` / `0` / `off` to disable x402 skill gates and Tier 3 search fees entirely. Use `X402_NETWORK_MODE=mainnet` when a non-production worker still needs to advertise real mainnet payment terms for Lobster/Corbits e2e.

## Architecture

Unbrowse is a monorepo with two tiers:

**Local server** (`localhost:6969`) -- Handles the core workflow: intent resolution, browser capture, skill execution, auth management, background indexing, payment gates. Local routes are handled directly; marketplace routes are proxied transparently.

**Backend API** (`beta-api.unbrowse.ai`) -- Cloudflare Worker that powers the shared marketplace:

- **Skill storage** -- KV-backed skill manifests with versioning and intent-based dedup
- **Discovery** -- Semantic vector search using Gemini embeddings (1536-dim) indexed in EmergentDB, with KV keyword fallback
- **Scoring** -- EMA-based reliability scoring factoring success ratio, consecutive failures, feedback ratings, schema drift, and verification status
- **Agents** -- Self-registration via Unkey API keys, profiles tracking contributions
- **Endpoint graph** -- Operation nodes and typed edges (parent/child, pagination, auth) published alongside skills
- **Transactions** -- KV-based payment ledger with consumer/creator visibility
- **Issues** -- Auto-filed from agent telemetry and manual agent reports
## Authentication

For sites that require login, unbrowse opens a visible browser window and waits for you to complete the login flow. Cookies and session state are saved to a persistent profile under `~/.unbrowse/profiles/<domain>/` and reused automatically on subsequent captures.

```bash
# Login once
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://calendar.google.com"}'

# All future captures for that domain use the saved session automatically
curl -s -X POST http://localhost:6969/v1/intent/resolve \
  -H "Content-Type: application/json" \
  -d '{"intent": "get my upcoming events", "params": {"url": "https://calendar.google.com"}}'
```

### How marketing-page redirects are handled

Many sites redirect unauthenticated users to a marketing or product page (e.g. `calendar.google.com` -> `workspace.google.com/products/calendar`) instead of a login form. Unbrowse detects this after the initial navigation and automatically redirects the browser to the correct sign-in URL.

Built-in providers:

| Service                            | Sign-in URL used                                     |
| ---------------------------------- | ---------------------------------------------------- |
| Google (Calendar, Drive, Gmail...) | `accounts.google.com/ServiceLogin?continue=<target>` |
| Microsoft / Office 365 / Teams     | `login.microsoftonline.com/...`                      |
| GitHub                             | `github.com/login?return_to=<path>`                  |
| Notion                             | `notion.so/login`                                    |
| LinkedIn                           | `linkedin.com/login`                                 |
| Twitter / X                        | `x.com/i/flow/login`                                 |
| Slack                              | `slack.com/signin`                                   |
| Atlassian (Jira, Confluence)       | `id.atlassian.com/login`                             |
| Salesforce                         | `login.salesforce.com`                               |
| Figma                              | `figma.com/login`                                    |
| Airtable                           | `airtable.com/login`                                 |
| Dropbox                            | `dropbox.com/login`                                  |
| HubSpot                            | `app.hubspot.com/login`                              |

For anything not in this table, unbrowse falls back to `<origin>/login`. If that's wrong, pass the login URL directly instead of the app URL:

```bash
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://app.example.com/auth/sso"}'
```

To add a new provider, append an entry to `SIGN_IN_PROVIDERS` in `src/auth/index.ts`.

## Debug logs

All auth and capture activity is logged to:

```
~/.unbrowse/logs/unbrowse-YYYY-MM-DD.log
```

A new file is created each day. Logs are also printed to the server terminal in real time.

To tail live logs:

```bash
tail -f ~/.unbrowse/logs/unbrowse-$(date +%F).log
```

Log files are plain text and safe to share when reporting issues (cookie values are present -- redact before sharing if needed).

## Data directories

| Path                             | Contents                                                    |
| -------------------------------- | ----------------------------------------------------------- |
| `~/.unbrowse/profiles/<domain>/` | Persistent browser profile (cookies, localStorage, session) |
| `~/.unbrowse/config.json`        | Agent credentials and marketplace API key                   |
| `~/.unbrowse/logs/`              | Daily debug logs                                            |
| `~/.unbrowse/skill-snapshots/`   | Cached skill manifests from background indexing              |
| `~/.unbrowse/route-cache.json`   | Intent+URL to skill route cache (24h TTL)                   |
| `~/.unbrowse/domain-skill-cache.json` | Domain to skill mapping for cross-intent reuse (7d TTL) |
| `~/.unbrowse/traces/`            | Anonymized route trace artifacts for telemetry              |

## Environment variables

| Variable           | Default                 | Description                                            |
| ------------------ | ----------------------- | ------------------------------------------------------ |
| `PORT`             | `6969`                  | Server port                                            |
| `HOST`             | `127.0.0.1`             | Server bind address (localhost only by default)        |
| `UNBROWSE_URL`     | `http://localhost:6969` | Base URL used by the skill                             |
| `UNBROWSE_API_KEY` | (auto-generated)        | Marketplace API key (auto-registered on first startup) |
| `UNBROWSE_API_URL` | `beta-api.unbrowse.ai`  | Backend API URL override                               |
