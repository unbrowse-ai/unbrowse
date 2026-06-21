# Unbrowse

> **The Unbrowse client boundary is open and auditable.** The local runtime, CLI bridge, SDK, drop-in adapters, and wallet/auth/signing layer are MIT and readable here, so you can verify what runs on your machine rather than trust a black box. The backend owns the route graph, ranking, settlement, and recursive contract compilation; the client sees only typed holes, approvals, pointer-only receipts, and wallet-sealed values. Company route IP stays behind typed contracts: end users ask for results, not raw internal API maps, auth material, HAR payloads, or PII. Inspect the live bridge contract at `GET /v1/contract/surface`. See [docs/OPEN-SOURCE-NOTICE.md](./docs/OPEN-SOURCE-NOTICE.md) for the exact open/private split.

Unbrowse is a local Agent Skill, CLI, and TypeScript SDK that turns websites into reusable API routes for agents. It learns callable routes from real browsing, keeps credentials local, and shares only sanitized route metadata with the marketplace when you explicitly publish. MCP remains available as a compatibility surface.

The working claim is deliberately narrow: if a site already exposes a first-party route behind its UI, an agent should reuse that route instead of rediscovering it through a browser on every call.

The route graph is also a compensation surface. Routes are maintained assets, not anonymous scraped blobs: indexers can be paid when their routes are reused, site-owner splits are supported where claimed, and credentials stay local through pointer-only receipts and wallet-sealed values. When a call depends on an unavoidable paid upstream, Unbrowse keeps the settlement path explicit instead of hiding the cost in an agent loop. Details live in [docs/HOW_UNBROWSE_PAYS.md](./docs/HOW_UNBROWSE_PAYS.md).

The measured result in the first paper is a **3.6× mean speedup and 5.4× median speedup** across 94 live domains when warmed cached routes replace browser automation, with sharply lower token use because the agent receives structured data instead of a page dump. See [arXiv:2604.00694](https://arxiv.org/abs/2604.00694). For current release-coverage methodology (corpus shape, rubric, current numbers), see [docs/benchmarks.md](./docs/benchmarks.md).

On adversarial, JavaScript-challenge-gated anti-bot content, a reproducible nine-post retrieval benchmark across three communities of a major social platform — ground-truthed against the platform's own data — recovers the real content on **9/9 posts where a naive HTTP client is blocked on every request (HTTP 403)**. The benchmark is re-runnable and reports the naive-vs-Unbrowse head-to-head directly.

On a **live-harvested adversarial corpus** — 24 sites mined each run from r/webscraping (the domains practitioners report fighting) plus curated vendor-gated, SPA, and GraphQL targets — the shipped binary's API-native `resolve`→`execute` path covers **12/24 (50%)** on retrieval, with the misses concentrated on JavaScript-challenge and commercial anti-bot gates (Cloudflare, DataDome) that route through the browser-capture path rather than the thin API path. The credential-redaction / no-secret-on-the-wire security invariant holds across **all 24** sites, including the blocked ones. The corpus is re-harvested and re-scored each run, anti-bot misses are recorded with their vendor class (never relabelled a pass), and every number is a gate that exits 0 only when the run was honest — see [docs/benchmarks.md](./docs/benchmarks.md#live-adversarial-corpus-coverage).

Exa/BrowseComp release truth is guarded separately from historical triage logs.
Before treating any Exa or BrowseComp result as release evidence, run the
gate-manifest handoff in [`bench/exa/HANDOFF.md`](./bench/exa/HANDOFF.md):

```bash
python3 bench/exa/validate_gate_manifest.py
bun test tests/exa-gate-manifest.test.ts
bash bench/exa/gate_manifest_e2e.sh
```

That handoff is intentionally **HOLD**, not a benchmark-win claim: the robust
BrowseComp witness must still be a real `N >= 25` result above Exa's published
`0.336` target.

> Security note: capture and execution stay local by default. Credentials stay on your machine. Learned API contracts are only shared after an explicit checkpoint (`sync`, `close`, or manual `publish`). Agents should connect through the installed Agent Skill or the SDK hole surface.

## A Uniform Agent Interface

The current client boundary is a **hole/contract**: the model fills only the holes it can know, and the runtime chooses the cheapest capable layer. The formal bridge is machine-readable:

```bash
curl https://beta-api.unbrowse.ai/v1/contract/surface
```

The bridge exposes five client-fillable holes:

- `intent`
- `wallet_proof`
- `approval`
- `local_capability_result`
- `typed_pointer`

In the CLI and SDK this is one tool:

```bash
unbrowse "the top Hacker News stories with points"
unbrowse "the top Hacker News stories with points" --url "https://news.ycombinator.com"
```

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const result = await hole.fill({
  intent: "get the top Hacker News stories with points",
  url: "https://news.ycombinator.com",
});
```

Internally the runtime may resolve a route, execute a captured endpoint, call a standard adapter, open a browser, reuse local cookies, inspect HAR, capture a new route, and index it. The agent-facing contract is the hole, not that internal ladder.

The older CLI surface remains for compatibility and route debugging. It is shaped as three verbs:

| Verb | What it is | Examples |
|---|---|---|
| `create` | **Declare** what you'll reuse — a skill, a fill-template, a value-source. | `create skill`, `create template` |
| `act` | **Act** on the internet — navigate, fill, click, type, submit, execute. | `act go`, `act fill`, `act execute` |
| `read` | **Observe** state — snapshot, resolve, read, status, earnings. | `read snap`, `read resolve`, `read text` |

Each op produces a **pointer-only, wallet-signed receipt**: it points *at* values (a URL, a `value:ptr`, a `sha256:` address) and carries a signature from your key — it never carries the secret value itself. `act fill` dereferences a credential pointer **locally** and types the result into the page; the secret never crosses the wire. *We never see your secret values.*

Receipts are Ed25519-signed today. Stronger authorization and provenance schemes are an active research direction; specifics will be detailed in a forthcoming whitepaper. The pointer-only invariant holds regardless. Full public surface — the hole contract, compatibility ops, the receipt shape, and the honest open/closed split — is in [docs/agent-internet-layer.md](./docs/agent-internet-layer.md).

> The bare `unbrowse "task"` front door routes to the one-hole path; the three-verb CLI (`build`/`act`/`eval`) is the explicit surface underneath. New integrations should target `unbrowse "task"`, `createHole().fill(...)`, or inspect the live bridge contract at `GET /v1/contract/surface`.

## Drop-in client adapters

Already using a search or browsing client? Swap one import. Unbrowse ships **drop-in
adapters** that mirror the call shapes of `exa-js`, `@tavily/core`, and `browser-use`, all
routed through a single streaming hole contract (resolve → execute → capture; a browser opens
only as a fallback) that can be wallet-bound so each request is Ed25519-signed:

```ts
import Exa from "unbrowse/sdk/adapters/exa";        // was: import Exa from "exa-js"
const { results } = await new Exa(key).search("anthropic news", { numResults: 5 });
```

Full surface (exa / tavily / browser-use + the wallet-protected hole tool): [docs/adapters.md](./docs/adapters.md).

## Install — pick one

### Option 1 — Agent Skill + CLI

Install the binary, then run setup. Setup installs the Unbrowse Agent Skill by default and does not write MCP host configs.

```bash
npm i -g unbrowse
unbrowse build setup
```

Skill-aware hosts read `~/.claude/skills/unbrowse/SKILL.md` and learn the current hole/contract surface. For legacy MCP hosts, run the stdio server manually:

```bash
unbrowse mcp
```

`unbrowse mcp` remains a manual stdio compatibility server for hosts that still need MCP.

### Option 2 — TypeScript SDK

One SDK, one install. The current SDK surface is the hole: `createHole().fill(...)`.

```bash
npm i unbrowse
```

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole({ client: { apiKey: process.env.UNBROWSE_API_KEY } });
const data = await hole.fill({
  intent: "search Hacker News for AI agent papers",
  url: "https://news.ycombinator.com",
});
```

Register at [unbrowse.ai/login?cli=1](https://unbrowse.ai/login?cli=1) for an API key. The same install also provides the `unbrowse` CLI and legacy MCP server (`npx unbrowse mcp`) — see [SKILL.md](./SKILL.md) for the full surface.

### Option 3 — Standalone CLI

If you just want the binary on your machine:

```bash
curl -fsSL https://unbrowse.ai/install.sh | sh
```

The installer detects your platform, downloads the matching release tarball, installs `unbrowse` into `~/.local/bin`, then runs `unbrowse build setup`.

For OpenClaw / `agent-browser` users, the plugin form is also still around — `npx unbrowse-openclaw install --restart` routes every `page.goto()` through Unbrowse — but it is no longer the primary install path.

### Option 4 — Drop-in shim for an existing browser tool

If you already have a codebase on Playwright, Firecrawl, or Browserbase Stagehand, change **one import line**:

```diff
- import { chromium } from 'playwright';
+ import { chromium } from '@unbrowse/playwright-shim';

- import Firecrawl from '@mendable/firecrawl-js';
+ import Firecrawl from '@unbrowse/firecrawl-shim';

- import { Stagehand } from '@browserbasehq/stagehand';
+ import { Stagehand } from '@unbrowse/stagehand-shim';
```

Every `goto / scrape / act / extract` short-circuits through the Unbrowse marketplace cache first. Cache hit → free synthesized response. Miss → falls through to the original library (kept as an optional peer dep) so your existing API key still works. **You pay the original vendor only when we miss.**

Side-by-side on each: [/compare/playwright](https://unbrowse.ai/compare/playwright), [/compare/firecrawl](https://unbrowse.ai/compare/firecrawl), [/compare/browserbase](https://unbrowse.ai/compare/browserbase).

## How payments work

Unbrowse routes monetize on use. Every `unbrowse_execute` against a priced route, every `unbrowse_search`, and any priced shortlist returned by `unbrowse_resolve` settles inline through HTTP-native micropayments on Solana mainnet via [Faremeter Flex](https://docs.faremeter.xyz/flex/overview) (v6.16+). The server replies `402 Payment Required` with a Flex-shaped `accepts[]`; the client signs an off-chain Ed25519 authorization with their session key; the response carries the proof. Protocol-level mechanics in the developer appendix below.

You have three ways to pay:

1. **Sponsored credit (default).** Brand-new agents get a daily allowance of platform-sponsored execute calls before they need to fund a wallet — so creators start earning USDC the moment their captured routes are reused. Sponsored responses include `X-Sponsored: <ledger_id>`. Once you've burned through the daily allowance the server returns 402 with `X-Sponsor-Exhausted: 1`; the SDK throws `SponsorExhaustedError`. Opt out per-request with `X-No-Sponsor: 1`.
2. **Your wallet + Flex escrow.** Pair a Solana mainnet wallet, fund a Flex escrow with USDC, register a session key — three steps walked through by `unbrowse build setup` or `/account`. The SDK catches `PaymentRequiredError`, calls `payAndRetryFlex(error, wallet)`, signs the authorization, packs a payment header, and returns the data. Your wallet's USDC ATA receives your contributor share when other agents replay routes you captured. The three-way split across the indexer, the platform, and (when claimed) the site owner is computed per signed authorization (`computeFlexSplits`). On **Solana mainnet today the platform settles those splits custodially** — it receives the payment and disburses each contributor's earned cut from the attribution ledger — because the **trustless on-chain atomic-split program is currently live on devnet only**, pending its mainnet deployment. The exact mechanics live in [`docs/concepts/fare-splits.md`](./docs/concepts/fare-splits.md).
3. **Stripe subscription + overage.** Same `/v1/account` surface, same `unbrowse_settings`, for teams that prefer a card on file.

> Protocol appendix (for implementers): the payment flow is the canonical [x402](https://www.x402.org) protocol; payment proofs travel in the `X-PAYMENT` request header. The runtime exposes `payAndRetryFlex` so most agents never touch the protocol directly.

Payment architecture: [`docs/concepts/fare-splits.md`](./docs/concepts/fare-splits.md). Wallet + escrow + session-key setup: [`docs/wallets.md`](./docs/wallets.md). SDK-level error handling: [`packages/sdk/docs/payments/`](./packages/sdk/docs/payments/).

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
- `workflow_contract://<skill>/<endpoint>` — sanitized replay contract: params, enums, prerequisites, payment requirements, provenance hints, next-state checks
- `workflow_dag://<skill>/<endpoint>` — dependency walk view for one indexed/published edge
- `plan_workflow_execution` — prompt scaffold for inspecting the contract + DAG before traversal vs explicit replay

For most MCP hosts the standard flow is `unbrowse_resolve` → `unbrowse_execute`. For JS-heavy or first-time capture, use the browser tool chain: `unbrowse_go` → `unbrowse_snap` → action tools → `unbrowse_submit` → `unbrowse_sync` → `unbrowse_close`.

## Common commands

```bash
unbrowse eval status
unbrowse mcp
unbrowse eval resolve --intent "get trending searches" --url "https://google.com" --pretty
unbrowse act auth --url "https://calendar.google.com"
unbrowse eval skills
unbrowse eval search --intent "get stock prices"
```

Contribute a verified route-delta to the shared graph (the client builds the proof
locally and posts only the route's structural shape — never captured traffic; the
server verifies the proof + origin attestation before admitting it):

```bash
unbrowse build contribute --endpoint "GET api.example.com/products" --origin "https://api.example.com" --params "page,limit"
unbrowse build contribute root   # the shared-graph commitment + endpoint count
```

Local capture/publish policy is configurable:

```bash
unbrowse eval config set telemetry false
unbrowse eval settings --auto-publish off
unbrowse eval settings --publish-blacklist "linkedin.com,x.com"
unbrowse eval settings --publish-promptlist "github.com"
```

Auto-publish is off by default. `fetch` stays local unless you pass `--publish`. Those settings only affect automatic publish after explicit checkpoints (`sync`, `close`). Local `index` still works, and explicit `publish` is still available with confirmation when a guarded domain is intentional.

## Upgrading

Unbrowse no longer self-updates at runtime. After each release, run:

```bash
unbrowse act upgrade
```

Codex and Claude hosts also get a session-start update hint during `unbrowse build setup`, so newer releases are surfaced before the CLI drifts too far behind.

If you installed from a repo clone:

```bash
cd ~/unbrowse
git pull --ff-only
./setup
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
- [`docs/for-agents/how-an-agent-uses-unbrowse.md`](./docs/for-agents/how-an-agent-uses-unbrowse.md) — route-level behavior and agent workflow
- [`docs/for-developers/integration-surfaces.md`](./docs/for-developers/integration-surfaces.md) — MCP, SDK, and CLI integration surfaces
- [`docs/concepts/fare-splits.md`](./docs/concepts/fare-splits.md) — payment + sponsor flow on Faremeter Flex
- [`docs/wallets.md`](./docs/wallets.md) — wallet, escrow, session-key setup, payout
- [`docs/SECURITY.md`](./docs/SECURITY.md) — security model for public packages and runtime integrity

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

1. **Passive capture** — the local runtime observes browser requests during an explicit session and keeps sensitive request material local.
2. **Checkpoint + indexing** — `sync` or `close` queues a background route-indexing pass; only sanitized route metadata is eligible for marketplace publish.
3. **Cache-first resolution** — In-memory cache → route cache (24h) → domain skill cache (7d) → local skill snapshots → marketplace semantic search → first-pass browser (8s) → live capture (last resort). Second visits resolve in <200 ms with no browser launch.
4. **Browser replacement API** — `Browser.launch()` + `page.goto()` from the `unbrowse` import resolves from the skill cache first; cache miss falls through to kuri.
5. **Endpoint graph** — Typed edges (list→detail, pagination, auth) prefetched in the same round-trip. `available_endpoints` in the resolve response reflects graph reachability given the agent's current bindings.
6. **Marketplace + payments** — New unverified submissions land in a shadow state until corroborated. Brand-new endpoints on an existing public skill also stay shadow until independently verified. Skill creators set a price per execution; sponsored calls cover brand-new agents' first calls so creators earn from day zero. See [`docs/concepts/fare-splits.md`](./docs/concepts/fare-splits.md) (payment + sponsor flow).

## Privacy — your credentials and data stay on your machine

What holds today:

- **Credentials are sealed to your wallet.** Saved auth/secret values are encrypted at rest to your wallet key and dereferenced **locally** at the moment of use; the plaintext value never crosses the wire. The backend can verify you *hold* a credential without ever receiving it (a cryptographic possession proof, not the secret).
- **Execution is local-first.** On the default path, a resolved route runs from your own machine straight to the target site — the request and its body do not pass through unbrowse's servers.
- **Routes are pointers, not maps.** The client sees typed holes and `sha256:` pointers to secret-stripped route structures, never raw internal API maps, HAR payloads, or PII.

**Credentials never cross unbrowse's servers in the clear — true today.** An auth-bearing egress request — one carrying any cookie, any value derived from the site's local/session storage, or any header beyond the generic ones an anonymous public request already sends (so an `Authorization`, an API key, a CSRF or session token, or any custom `X-*` header all count) — is never routed through the server's IP-escalation tier, which terminates TLS and could read it. Such a request stays on your own machine or your own proxy, or fails honestly; the cleartext credential never leaves for unbrowse's servers. What is still being closed (rolling out) is the **non-auth request body** on that same clean-IP escalation path: the proxy tier is moving to a blind end-to-end-encrypted tunnel where the server lends an IP, relays only ciphertext, and never terminates your TLS. Until that tunnel ships, a blocked auth-bearing request fails rather than escalating — and no absolute "servers never see any data" claim is made yet.

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
