# Unbrowse

Unbrowse is a local Model Context Protocol (MCP) server and CLI that turns any website into a reusable API interface for agents. It captures network traffic, reverse-engineers the real endpoints underneath the UI, and stores what it learns in a shared marketplace so the next agent can reuse it instantly.

One agent learns a site once. Every later agent gets the fast path.

Unbrowse is a drop-in replacement for OpenClaw / `agent-browser` browser flows for agents: on the API-native path it is typically ~30x faster, ~90% cheaper, and turns repeated browser work into reusable route assets.

> Security note: capture and execution stay local by default. Credentials stay on your machine. Learned API contracts are only shared after an explicit checkpoint pipeline (`sync`, `close`, or manual `publish`). See [SKILL.md](./SKILL.md) for the full agent-facing API reference and tool-policy guidance.

## MCP server

Unbrowse implements the Model Context Protocol over stdio. `unbrowse mcp` is the MCP server entrypoint.

- Protocol: JSON-RPC 2.0 MCP over stdio
- Handshake: `initialize`, `notifications/initialized`, `ping`
- Capability surface today: `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get`
- Current MCP shape: tool actuation plus read-only workflow contract/DAG resources and one planning prompt for indexed/published workflow execution.
- Runtime model: the MCP server fronts the local Unbrowse runtime on `http://localhost:6969`; hosts talk standard MCP, and Unbrowse uses the local HTTP runtime behind the scenes.

Core MCP tools:

- Discovery: `unbrowse_health`, `unbrowse_search`, `unbrowse_resolve`, `unbrowse_execute`, `unbrowse_feedback`
- Auth/cache: `unbrowse_login`, `unbrowse_skills`, `unbrowse_skill`, `unbrowse_sessions`
- Browser capture: `unbrowse_go`, `unbrowse_snap`, `unbrowse_click`, `unbrowse_fill`, `unbrowse_type`, `unbrowse_press`, `unbrowse_select`, `unbrowse_scroll`, `unbrowse_submit`, `unbrowse_screenshot`, `unbrowse_text`, `unbrowse_markdown`, `unbrowse_cookies`, `unbrowse_eval`, `unbrowse_sync`, `unbrowse_close`
- Local pipeline: `unbrowse_index`, `unbrowse_settings`

Indexed/published workflow MCP resources/prompts:

- `workflow_publish://<skill>` — exported workflow artifact summary for one indexed/published skill
- `workflow_contract://<skill>/<endpoint>` — sanitized replay contract: params, enums, prerequisites, x402/payment requirements, provenance hints, and next-state checks
- `workflow_dag://<skill>/<endpoint>` — dependency walk view for one indexed/published workflow edge
- `plan_workflow_execution` — prompt scaffold that tells the model to inspect the contract + DAG before choosing traversal vs explicit replay

Typical MCP host config:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse", "mcp"]
    }
  }
}
```

## Quick start

```bash
# One-line install from the latest GitHub release
curl -fsSL https://unbrowse.ai/install.sh | sh
```

That installer now follows the Kuri pattern: detect platform, download the matching release tarball, install `unbrowse` into `~/.local/bin`, then run `unbrowse setup`.

```bash
# Deterministic setup from a repo clone
git clone --single-branch --depth 1 https://github.com/unbrowse-ai/unbrowse.git ~/unbrowse
cd ~/unbrowse && ./setup --host off
```

`./setup` installs repo dependencies, prebuilds the packaged CLI runtime, installs a stable `unbrowse` shim, and runs `unbrowse setup` without depending on npm release assets. That first-run path includes ToS acceptance, agent registration + API-key caching, and wallet detection when present.

If a wallet is configured, that wallet address becomes the contributor truth: it is synced onto your agent profile, used as the destination for contributor payouts when your routes earn, and used as the spending wallet for paid marketplace routes.

Recommended for new installs: set up Crossmint `lobster.cash` during bootstrap. `unbrowse setup` will encourage it, and if the tooling is already present it will try `npx @crossmint/lobster-cli setup` automatically. That wallet becomes the payout destination for contributed routes and the spending wallet for paid marketplace routes.

Unbrowse supports wallet providers such as Crossmint `lobster.cash` for x402-gated routes. If you use `lobster.cash`, set `LOBSTER_WALLET_ADDRESS`. Other providers can use `AGENT_WALLET_ADDRESS` and optional `AGENT_WALLET_PROVIDER`.

Headless/CI-friendly bootstrap:

```bash
cd ~/unbrowse && ./setup --host off --accept-tos --agent-email you@example.com --skip-wallet-setup
```

For agent hosts with a skill directory:

```bash
git clone --single-branch --depth 1 https://github.com/unbrowse-ai/unbrowse.git ~/.codex/skills/unbrowse
cd ~/.codex/skills/unbrowse && ./setup --host codex
```

For generic MCP hosts:

```bash
git clone --single-branch --depth 1 https://github.com/unbrowse-ai/unbrowse.git ~/unbrowse
cd ~/unbrowse && ./setup --host mcp
```

That writes a ready-to-import MCP config to `~/.config/unbrowse/mcp/unbrowse.json`. A generic template is also published at [`/mcp.json`](https://www.unbrowse.ai/mcp.json).

If your agent host uses skills:

```bash
npx skills add unbrowse-ai/unbrowse
```

If you want to call the canonical local API from app code instead of shelling out to the CLI or MCP server:

```bash
npm install @unbrowse/sdk
```

```ts
import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = new Unbrowse();

const result = await unbrowse.resolve({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});
```

## Upgrading

Unbrowse no longer self-updates at runtime. If you already have Unbrowse installed, upgrade to the latest version after each release or the new flow may not work on your machine.

Check the exact command for your install with:

```bash
unbrowse upgrade
```

Codex and Claude installs now also get a session-start update hint during `unbrowse setup`, so newer releases are surfaced in the host before the CLI drifts too far behind.

If you installed from a repo clone:

```bash
cd ~/unbrowse
git pull --ff-only
./setup --host off
```

If you installed for a generic MCP host:

```bash
cd ~/unbrowse
git pull --ff-only
./setup --host mcp
```

If your agent host uses skills, rerun its skill install/update command too:

```bash
npx skills add unbrowse-ai/unbrowse
```

Need help or want release updates? Join the Discord: [discord.gg/VWugEeFNsG](https://discord.gg/VWugEeFNsG)

Public companion docs: [docs.unbrowse.ai](https://docs.unbrowse.ai)

Every CLI command auto-starts the local runtime on `http://localhost:6969` by default, and `unbrowse mcp` uses that same runtime behind the MCP stdio surface. Override with `UNBROWSE_URL`, `PORT`, or `HOST`. On first startup it auto-registers as an agent with the marketplace and caches credentials in `~/.unbrowse/config.json`. Interactive setup prompts for ToS acceptance and optionally an email-style agent identity. Headless runs can preseed `UNBROWSE_NON_INTERACTIVE=1`, `UNBROWSE_TOS_ACCEPTED=1`, and `UNBROWSE_AGENT_EMAIL=...`.

Works with Claude Code, Open Code, Cursor, Codex, Windsurf, and any agent host that can call a local CLI or skill.

## Repo checkout

For monorepo development, initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

This pulls the tracked Kuri source into `submodules/kuri` from [justrach/kuri](https://github.com/justrach/kuri.git). `npm pack --workspace packages/skill` then bundles platform-specific Kuri binaries from that source into the published CLI package.

## Docs

Long-form docs live under [`docs/`](./docs/). Public repo entrypoints:

- [`docs/guides/quickstart.md`](./docs/guides/quickstart.md) - canonical install, setup, and headless bootstrap path
- [`docs/api.md`](./docs/api.md) - route-level behavior and API contracts
- [`docs/deployment.md`](./docs/deployment.md) - deploy topology and release workflow behavior
- [`docs/RELEASING.md`](./docs/RELEASING.md) - release checklist and rerun-safe CI notes

Whitepaper companion set:

- [`docs/whitepaper/README.md`](./docs/whitepaper/README.md) - public companion index
- [`docs/whitepaper/for-technical-readers.md`](./docs/whitepaper/for-technical-readers.md) - architecture, eval truth, and product boundary
- [`docs/whitepaper/for-investors.md`](./docs/whitepaper/for-investors.md) - market and business framing
- [`docs/api.md`](./docs/api.md) - REST and TypeScript SDK surface
- [`docs/guides/quickstart.md`](./docs/guides/quickstart.md) - setup + first resolve

## What setup does

- Checks the local runtime/package-manager environment for the repo bootstrap or packaged CLI path.
- Prebuilds the packaged CLI runtime and installs the stable `unbrowse` shim for the repo bootstrap path.
- Verifies the bundled Kuri binary, or builds it from the vendored Kuri source when working from repo source with Zig installed.
- Registers the Open Code `/unbrowse` command when Open Code is present.
- Runs the first-use flow: ToS, agent registration/API-key caching, wallet detection, and Crossmint `lobster.cash` encouragement.
- Starts the local Unbrowse server unless `--no-start` is passed.

## Common commands

```bash
unbrowse health
unbrowse mcp
unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty
unbrowse login --url "https://calendar.google.com"
unbrowse skills
unbrowse search --intent "get stock prices"
```

For most MCP hosts, the standard flow is `unbrowse_resolve` first, then `unbrowse_execute`. For JS-heavy or first-time capture workflows, use the browser tool chain: `unbrowse_go -> unbrowse_snap -> action tools -> unbrowse_submit -> unbrowse_sync -> unbrowse_close`.

For indexed/published workflow contracts, treat the resolve/execute pair as the router/meta surface:

- `unbrowse_resolve` finds candidate indexed/published contracts
- `unbrowse_execute` runs one explicit replay contract
- `unbrowse_skill` / `unbrowse_skills` let you inspect the indexed/published surface
- MCP resources let hosts inspect the same surface before tool calls, including x402/payment requirements:
  - `workflow_contract://<skill>/<endpoint>`
  - `workflow_dag://<skill>/<endpoint>`
  - prompt `plan_workflow_execution`

Local capture/publish policy is configurable:

- `unbrowse settings --auto-publish off`
- `unbrowse settings --publish-blacklist "linkedin.com,x.com"`
- `unbrowse settings --publish-promptlist "github.com"`

Those settings only affect automatic publish after explicit checkpoints (`sync`, `close`). Local `index` still works, and explicit `publish` is still available with confirmation when a guarded domain is intentional.

## Dependency walk for multi-step UIs

Treat each successful browser submit as a dependency boundary.

- Do not jump straight to guessed downstream URLs like `/date-selection.html` or `/payment.html` unless the current session already reached them through the real page flow.
- Use `unbrowse_submit` for the actual transition, then trust the returned `url`, `session_id`, and any next-step hints over your own assumptions.
- `unbrowse_submit` is a thin browser-native proxy by default. Only opt into extra traversal help when you explicitly pass `--assist-site-state` or `same_origin_fetch_fallback`.
- `unbrowse_sync` after a good transition so the current capture is checkpointed and the background `index -> publish` pipeline records which request chain unlocked the next page.
- If a page later returns `abandonedCart`, `session_expired`, or a wrong audience/product variant, restart from the last known good upstream step and walk forward again.

The dependency graph is not just API-to-API. On JS-heavy checkout flows it also captures browser-state prerequisites: selected product, resident/non-resident audience, date, slot, auth, and cart state. Future agents should reason from those prerequisites before calling deeper steps.

## Demo notes

- First-time capture/indexing on a site can take 20-80 seconds. That is the slow path; repeats should be much faster.
- For website tasks, keep the agent on Unbrowse instead of letting it drift into generic web search or ad hoc `curl`.
- Reddit is still a harder target than most sites because of anti-bot protections. Prefer canonical `.json` routes when available.

## How it works

Unbrowse has a six-layer pipeline that turns any website into a reusable API:

### 1. Passive capture

When an agent navigates through Unbrowse, every network API call is intercepted and recorded with response bodies -- automatically, with no explicit capture step. The JS interceptor is injected via `Page.addScriptToEvaluateOnNewDocument` so early SPA hydration calls are never missed. Chrome extension webRequest data supplements the interceptor for service worker traffic.

### 2. Checkpoint + indexing

Captured traffic is checkpointed explicitly with `sync` or `close`, then reverse-engineered into API endpoints in the background without blocking the agent. The indexer extracts endpoints, builds an operation graph, and writes results to a local skill cache plus workflow export. Remote share/publish is a later pipeline step queued from those checkpoint commands or run explicitly with `publish`.

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

Every learned skill is published to the shared marketplace. New unverified submissions now land in a shadow state first: persisted, attributable, and readable by ID, but not indexed into the shared graph until they are verified or corroborated by a second submitter. Official release binaries now attach a signed release manifest on publish, and once a skill is already public any brand-new endpoint stays shadow until that specific endpoint is independently corroborated or verified. Skills captured by agent A are then discoverable by agent B on a different machine via semantic vector search. Errors agents encounter automatically file GitHub issues with full repro context (intent, URL, endpoint ID, error, kuri version).

Skill creators can set a price per execution. Agents with funded wallets pay for paid skills; free skills remain free. Creator payout wallets are synced from agent registration/runtime wallet state. Today paid skills route to a single payout wallet: the current majority contributor, with first-contributor winning ties. That winner wallet must be Solana mainnet USDC-ready (have a USDC token account) or Corbits settlement will fail even if the x402 proof is otherwise valid.

For Cascade split provisioning during publish, set either:

- `UNBROWSE_CASCADE_SPLIT_ADDRESS` or `UNBROWSE_CASCADE_SPLIT_CONFIG` to pin an already-created split config address
- or `UNBROWSE_CASCADE_PLATFORM_WALLET`, `UNBROWSE_CASCADE_SIGNER_SECRET_KEY`, `UNBROWSE_CASCADE_RPC_URL`, and `UNBROWSE_CASCADE_RPC_WS_URL` to auto-create/update the split via `@cascade-fyi/splits-sdk`

Worker payment gating is controlled by `PAYMENTS_ENABLED`. Set it to `false` / `0` / `off` to disable all x402 gates. To keep discovery free while still gating paid skill manifests and execution detail, set `X402_SEARCH_ENABLED=false`. Use `X402_NETWORK_MODE=mainnet` when a non-production worker still needs to advertise real mainnet payment terms for Lobster/Corbits e2e.

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
