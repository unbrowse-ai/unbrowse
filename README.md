# Unbrowse

> **Heads up: this OSS repo is a 2025 snapshot.** Current production builds are closed-source for safety reasons. The TypeScript SDK (`@unbrowse/sdk`) is MIT and is the supported integration surface. See [docs/OPEN-SOURCE-NOTICE.md](./docs/OPEN-SOURCE-NOTICE.md) for what's open vs. proprietary.

Unbrowse is a local Model Context Protocol (MCP) server, CLI, and TypeScript SDK that turns any website into a reusable API for agents. It captures network traffic, reverse-engineers the real endpoints underneath the UI, and stores what it learns in a shared marketplace so the next agent can reuse it instantly.

One agent learns a site once. Every later agent gets the fast path.

On the API-native path Unbrowse is typically ~30x faster and ~90x cheaper than driving a browser, and turns repeated browser work into reusable, payable route assets.

> Security note: capture and execution stay local by default. Credentials stay on your machine. Learned API contracts are only shared after an explicit checkpoint (`sync`, `close`, or manual `publish`). Agents should connect via the MCP server or the SDK.

## Install — pick one

### Option 1 — MCP (drop-in for any MCP host)

Add this once to your host config (Claude Desktop, Cursor, Codex, Open Code, Windsurf, or anything that speaks MCP):

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

That's it. `npx` fetches the `unbrowse` binary on first run; every web task in that host now routes through Unbrowse. Local browsing tools (`unbrowse_go`, `unbrowse_snap`, `unbrowse_eval`, `unbrowse_fetch`) work without registration. Backend-bound tools (`unbrowse_resolve`, `unbrowse_execute`, `unbrowse_publish`, `unbrowse_earnings`) require an API key — register at [unbrowse.ai/login?cli=1](https://unbrowse.ai/login?cli=1) or run `npx unbrowse register`. To earn USDC on captured routes, pair a wallet via `npx @crossmint/lobster-cli setup`.

### Option 2 — TypeScript SDK

For agents you write yourself (LangChain, CrewAI, your own loop), use the SDK. It auto-spawns the binary for you, no separate `setup` step required.

```bash
npm install @unbrowse/sdk
```

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = await Unbrowse.local();

const result = await u.resolve({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});
```

`Unbrowse.local()` probes `127.0.0.1:6969`, connects if a daemon is already running, and spawns the `unbrowse` CLI as a child process if not. See [`packages/sdk/README.md`](./packages/sdk/README.md) for `connect()` and `spawn()` factories, and [`packages/sdk/docs/payments/`](./packages/sdk/docs/payments/) for the payment surface.

### Option 3 — Standalone CLI

If you just want the binary on your machine:

```bash
curl -fsSL https://unbrowse.ai/install.sh | sh
```

The installer detects your platform, downloads the matching release tarball, installs `unbrowse` into `~/.local/bin`, then runs `unbrowse setup`.

For OpenClaw / `agent-browser` users, the plugin form is also still around — `npx unbrowse-openclaw install --restart` routes every `page.goto()` through Unbrowse — but it is no longer the primary install path.

## How payments work

Unbrowse routes monetize on use. Every `unbrowse_execute` against a priced route, every `unbrowse_search`, and any priced shortlist returned by `unbrowse_resolve` runs through the canonical [x402](https://www.x402.org) payment flow on Solana mainnet, settled via [Faremeter Flex](https://docs.faremeter.xyz/flex/overview) (v6.16+). The server replies `402 Payment Required` with a Flex-shaped `accepts[]`; the client signs an off-chain Ed25519 authorization with their session key; the response carries the proof.

You have three ways to pay:

1. **Sponsored credit (default).** Brand-new agents get a daily allowance of platform-sponsored execute calls before they need to fund a wallet — so creators start earning USDC the moment their captured routes are reused. Sponsored responses include `X-Sponsored: <ledger_id>`. Once you've burned through the daily allowance the server returns 402 with `X-Sponsor-Exhausted: 1`; the SDK throws `SponsorExhaustedError`. Opt out per-request with `X-No-Sponsor: 1`.
2. **Your wallet + Flex escrow (x402).** Pair a Solana mainnet wallet, fund a Flex escrow with USDC, register a session key — three steps walked through by `unbrowse setup` or `/account`. The SDK catches `PaymentRequiredError`, calls `payAndRetryFlex(error, wallet)`, signs the authorization, packs an `X-PAYMENT` header, and returns the data. Your wallet's USDC ATA also receives your contributor share when other agents replay routes you captured. Splits live natively in every signed authorization (90% to contributors, 10% to platform, 0% protocol fee, up to 5 recipients).
3. **Stripe subscription + overage.** Same `/v1/account` surface, same `unbrowse_settings`, for teams that prefer a card on file.

Walkthrough and diagrams: [`docs/x402-flywheel.md`](./docs/x402-flywheel.md). Wallet + escrow + session-key setup: [`docs/wallets.md`](./docs/wallets.md). Upgrading from v6.15's `exact`-scheme integration: [`docs/x402-flex-migration.md`](./docs/x402-flex-migration.md). SDK-level error handling: [`packages/sdk/docs/payments/`](./packages/sdk/docs/payments/).

## MCP server

`unbrowse mcp` is the MCP server entrypoint over stdio.

- Protocol: JSON-RPC 2.0 MCP over stdio
- Handshake: `initialize`, `notifications/initialized`, `ping`
- Capability surface: `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`
- Runtime model: the MCP server fronts the local Unbrowse runtime on `http://localhost:6969`; hosts talk standard MCP, and Unbrowse uses the local HTTP runtime behind the scenes.

Core MCP tools:

- Discovery: `unbrowse_health`, `unbrowse_search`, `unbrowse_resolve`, `unbrowse_execute`, `unbrowse_feedback`
- Auth/cache: `unbrowse_login`, `unbrowse_skills`, `unbrowse_skill`, `unbrowse_sessions`
- Browser capture: `unbrowse_go`, `unbrowse_snap`, `unbrowse_click`, `unbrowse_fill`, `unbrowse_type`, `unbrowse_press`, `unbrowse_select`, `unbrowse_scroll`, `unbrowse_submit`, `unbrowse_screenshot`, `unbrowse_text`, `unbrowse_markdown`, `unbrowse_cookies`, `unbrowse_eval`, `unbrowse_sync`, `unbrowse_close`
- Local pipeline + introspection: `unbrowse_index`, `unbrowse_settings` (now also reports `sponsor_status` — daily credit remaining and cap)

Indexed/published workflow MCP resources/prompts:

- `workflow_publish://<skill>` — exported workflow artifact summary
- `workflow_contract://<skill>/<endpoint>` — sanitized replay contract: params, enums, prerequisites, x402/payment requirements, provenance hints, next-state checks
- `workflow_dag://<skill>/<endpoint>` — dependency walk view for one indexed/published edge
- `plan_workflow_execution` — prompt scaffold for inspecting the contract + DAG before traversal vs explicit replay

For most MCP hosts the standard flow is `unbrowse_resolve` → `unbrowse_execute`. For JS-heavy or first-time capture, use the browser tool chain: `unbrowse_go` → `unbrowse_snap` → action tools → `unbrowse_submit` → `unbrowse_sync` → `unbrowse_close`.

## Common commands

```bash
unbrowse health
unbrowse mcp
unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty
unbrowse login --url "https://calendar.google.com"
unbrowse skills
unbrowse search --intent "get stock prices"
```

Local capture/publish policy is configurable:

```bash
unbrowse config set telemetry false
unbrowse settings --auto-publish off
unbrowse settings --publish-blacklist "linkedin.com,x.com"
unbrowse settings --publish-promptlist "github.com"
```

Auto-publish is off by default. `fetch` stays local unless you pass `--publish`. Those settings only affect automatic publish after explicit checkpoints (`sync`, `close`). Local `index` still works, and explicit `publish` is still available with confirmation when a guarded domain is intentional.

## Upgrading

Unbrowse no longer self-updates at runtime. After each release, run:

```bash
unbrowse upgrade
```

Codex and Claude hosts also get a session-start update hint during `unbrowse setup`, so newer releases are surfaced before the CLI drifts too far behind.

If you installed from a repo clone:

```bash
cd ~/unbrowse
git pull --ff-only
./setup --host off
```

Need help or want release updates? Discord: [discord.gg/VWugEeFNsG](https://discord.gg/VWugEeFNsG). Public docs: [docs.unbrowse.ai](https://docs.unbrowse.ai).

## Repo checkout

For monorepo development, initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

This pulls the tracked Kuri source into `submodules/kuri` from [justrach/kuri](https://github.com/justrach/kuri.git). `npm pack --workspace packages/skill` (directory name historical — the package publishes as `unbrowse` on npm) then bundles platform-specific Kuri binaries from that source into the published CLI package.

## Docs

Long-form docs live under [`docs/`](./docs/). Public repo entrypoints:

- [`docs/guides/quickstart.md`](./docs/guides/quickstart.md) — canonical install, setup, and headless bootstrap path
- [`docs/api.md`](./docs/api.md) — route-level behavior and API contracts
- [`docs/deployment.md`](./docs/deployment.md) — deploy topology and release workflow behavior
- [`docs/x402-flywheel.md`](./docs/x402-flywheel.md) — payment + sponsor flow on Faremeter Flex
- [`docs/wallets.md`](./docs/wallets.md) — wallet, escrow, session-key setup, payout
- [`docs/x402-flex-migration.md`](./docs/x402-flex-migration.md) — v6.15 (`exact` + Corbits) → v6.16 (Flex) migration for integrators
- [`docs/RELEASING.md`](./docs/RELEASING.md) — release checklist

Whitepaper companion set:

- [`docs/whitepaper/README.md`](./docs/whitepaper/README.md) — public companion index
- [`docs/whitepaper/for-technical-readers.md`](./docs/whitepaper/for-technical-readers.md) — architecture, eval truth, product boundary
- [`docs/whitepaper/for-investors.md`](./docs/whitepaper/for-investors.md) — market and business framing

## Architecture

Unbrowse is a monorepo with two tiers:

**Local server** (`localhost:6969`) — Handles the core workflow: intent resolution, browser capture, skill execution, auth management, background indexing, payment gates. Local routes are handled directly; marketplace routes are proxied transparently.

**Backend API** (`beta-api.unbrowse.ai`) — Cloudflare Worker that powers the shared marketplace:

- **Skill storage** — KV-backed skill manifests with versioning and intent-based dedup
- **Discovery** — Semantic vector search using Gemini embeddings (1536-dim) indexed in EmergentDB, with KV keyword fallback
- **Scoring** — EMA-based reliability scoring factoring success ratio, consecutive failures, feedback ratings, schema drift, and verification status
- **Agents** — Self-registration via Unkey API keys, profiles tracking contributions
- **Endpoint graph** — Operation nodes and typed edges (parent/child, pagination, auth) published alongside skills
- **Transactions** — KV-based payment ledger with consumer/creator visibility (and a sponsor-ledger lane for platform-funded calls)
- **Issues** — Auto-filed from agent telemetry and manual agent reports

Six-layer pipeline:

1. **Passive capture** — JS interceptor injected via `Page.addScriptToEvaluateOnNewDocument`; Chrome extension webRequest data supplements for service-worker traffic.
2. **Checkpoint + indexing** — `sync` or `close` triggers a background reverse-engineer pass into endpoints + an operation graph; remote publish queued from the same checkpoint.
3. **Cache-first resolution** — In-memory cache → route cache (24h) → domain skill cache (7d) → local skill snapshots → marketplace semantic search → first-pass browser (8s) → live capture (last resort). Second visits resolve in <200 ms with no browser launch.
4. **Browser replacement API** — `Browser.launch()` + `page.goto()` from the `unbrowse` import resolves from the skill cache first; cache miss falls through to kuri.
5. **Endpoint graph** — Typed edges (list→detail, pagination, auth) prefetched in the same round-trip. `available_endpoints` in the resolve response reflects graph reachability given the agent's current bindings.
6. **Marketplace + payments** — New unverified submissions land in a shadow state until corroborated. Brand-new endpoints on an existing public skill also stay shadow until independently verified. Skill creators set a price per execution; sponsored calls cover brand-new agents' first calls so creators earn from day zero. See `docs/x402-flywheel.md`.

## Authentication

For sites that require login, Unbrowse opens a visible browser window and waits for you to complete the login flow. Cookies and session state are saved to a persistent profile under `~/.unbrowse/profiles/<domain>/` and reused automatically.

```bash
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://calendar.google.com"}'
```

### How marketing-page redirects are handled

Many sites redirect unauthenticated users to a marketing page (e.g. `calendar.google.com` → `workspace.google.com/products/calendar`) instead of a login form. Unbrowse detects this and redirects to the canonical sign-in URL for Google, Microsoft, GitHub, Notion, LinkedIn, X, Slack, Atlassian, Salesforce, Figma, Airtable, Dropbox, and HubSpot. For anything not in that table, Unbrowse falls back to `<origin>/login`. If that's wrong, pass the login URL directly. To add a provider, append an entry to `SIGN_IN_PROVIDERS` in `src/auth/index.ts`.

## Debug logs

All auth and capture activity is logged to `~/.unbrowse/logs/unbrowse-YYYY-MM-DD.log` (one file per day) and printed to the server terminal in real time.

```bash
tail -f ~/.unbrowse/logs/unbrowse-$(date +%F).log
```

Log files are plain text — cookie values are present, so redact before sharing.

## Data directories

| Path                                  | Contents                                                    |
| ------------------------------------- | ----------------------------------------------------------- |
| `~/.unbrowse/profiles/<domain>/`      | Persistent browser profile (cookies, localStorage, session) |
| `~/.unbrowse/config.json`             | Agent credentials and marketplace API key                   |
| `~/.unbrowse/logs/`                   | Daily debug logs                                            |
| `~/.unbrowse/skill-snapshots/`        | Cached skill manifests from background indexing             |
| `~/.unbrowse/route-cache.json`        | Intent+URL → skill route cache (24h TTL)                    |
| `~/.unbrowse/domain-skill-cache.json` | Domain → skill mapping for cross-intent reuse (7d TTL)      |
| `~/.unbrowse/traces/`                 | Anonymized route trace artifacts for telemetry              |

## Environment variables

| Variable           | Default                 | Description                                            |
| ------------------ | ----------------------- | ------------------------------------------------------ |
| `PORT`             | `6969`                  | Server port                                            |
| `HOST`             | `127.0.0.1`             | Server bind address (localhost only by default)        |
| `UNBROWSE_URL`     | `http://localhost:6969` | Base URL used by the SDK and skill-bundle              |
| `UNBROWSE_API_KEY` | (auto-generated)        | Marketplace API key (auto-registered on first startup) |
| `UNBROWSE_API_URL` | `beta-api.unbrowse.ai`  | Backend API URL override                               |
