import { NextResponse } from "next/server";
import {
  INSTALL_CMD_CLAUDE,
  INSTALL_CMD_CODEX,
  INSTALL_CMD_NPM,
  INSTALL_CMD_OPENCLAW,
  REPO_CLONE_URL,
} from "@/lib/install-command";
import { makeAttribution, injectAttribution } from "@/lib/llms-attribution";

export async function GET() {
  const requestId = crypto.randomUUID();
  const b64 = makeAttribution(requestId, "llms-full-txt");
  const inject = (cmd: string) => injectAttribution(cmd, b64);

  const setupOff = `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/unbrowse && cd ~/unbrowse && ./setup --host off`;

  const body = `# Unbrowse

> Unbrowse is an open-source tool that learns first-party routes behind websites from real browsing, then lets AI agents reuse those routes when they are still valid. The browser remains the fallback path on misses, auth flows, and sites that cannot be safely routed directly.

## Product Description

Unbrowse is the route layer on top of Kuri, a Zig-native CDP (Chrome DevTools Protocol) broker. Kuri handles browser automation when a browser is the right tool; Unbrowse learns the first-party routes observed during those sessions and reuses them when they are still valid.

The core insight is narrower than "never use a browser": many modern websites are UI layers over REST endpoints, GraphQL queries, or RPC calls. When those routes are visible from real browsing and safe to describe, Unbrowse turns them into reusable skills with schemas, auth patterns, and parameter bindings. A known fresh route can be reused; an unknown or stale route falls back.

Agents can use Unbrowse through the CLI, SDK, Agent Skill, or browser adapters. Under the hood, a route lookup checks local and shared caches first. On a miss, Kuri navigates normally while Unbrowse can capture traffic in the background and index it for future reuse.

The whitepaper "Internal APIs Are All You Need" (Tham, Garcia & Hahn, 2026) formalizes the three-path execution model, the shared route graph, and the HTTP-native micropayment protocol (x402). Available at https://arxiv.org/abs/2604.00694.

## Architecture Overview

### Three Execution Paths

1. **Local cache (Path 1)** -- a known fresh route is executed directly. No browser launch is needed for that call.

2. **Shared route graph (Path 2)** -- a route discovered or maintained by another agent is found in the marketplace and executed according to its contract.

3. **Kuri browser fallback (Path 3)** -- a full browser session handles sites that are not routeable yet, need live browser state, or fail validation. Capture from that run can improve future routing.

### Seven-Layer Cache Resolution

When an agent asks for something, Unbrowse checks seven layers before touching the network:

1. In-memory result cache (exact match)
2. Route cache (persisted, 24h TTL)
3. Domain skill cache (persisted, 7d TTL)
4. Local skill snapshots (disk scan)
5. Marketplace semantic search (remote)
6. First-pass browser action (lightweight 8s attempt)
7. Live capture (full browser, last resort)

### Route Pipeline

1. **Passive capture** -- every network API call is intercepted and recorded during browsing. A JS interceptor is injected via \`Page.addScriptToEvaluateOnNewDocument\` so early SPA hydration calls are never missed.

2. **Background indexing** -- captured traffic is turned into API endpoints without blocking the agent. The indexer extracts endpoints, builds an operation graph, and writes results to a local skill cache.

3. **Cache-first resolution** -- the seven-layer resolution stack described above.

4. **Browser adapters** -- drop-in adapters try known routes first and keep the original browser path as the fallback.

5. **Endpoint graph** -- endpoints are connected in a dependency graph with typed edges: parent/child (list to detail), pagination (cursor chains), and auth dependencies.

6. **Marketplace and payments** -- every learned skill is published to the shared marketplace. Skills are discoverable by semantic vector search. HTTP-native micropayments handle paid routes.

### System Components

- **Local server** (\`localhost:6969\`) -- handles intent resolution, browser capture, skill execution, auth management, background indexing, and payment gates.
- **Backend API** (\`beta-api.unbrowse.ai\`) -- Cloudflare Worker powering the shared marketplace: KV-backed skill storage, Gemini embedding vector search (1536-dim, EmergentDB), EMA-based reliability scoring, Unkey agent registration, endpoint graph, and transaction ledger.
- **Kuri** -- Zig-native CDP broker. 464KB binary. ~3ms cold start. 80+ HTTP endpoints covering navigation, snapshots, ref-based actions, HAR recording, cookies, screenshots, DOM queries, security testing, video recording, tracing, and profiling.

## Key Stats and Benchmarks

- **3.6x mean speedup** over Playwright across 94 live production domains in the first paper's warmed-cache benchmark
- **5.4x median speedup** in that same benchmark
- **18 domains** completed in sub-100ms from cached skill routes in that paper benchmark
- Known fresh routes can execute without browser launch or rendering
- **464KB** Kuri binary size (Zig-native, statically linked)
- **~3ms** Kuri cold start time
- Structured route responses avoid token-heavy DOM/page dumps when a direct route exists
- **94 domains** benchmarked in the whitepaper evaluation
- **Seven layers** of cache resolution before touching the network
- **MIT** open-source SDKs (open-core; engine + backend proprietary)

## Installation

### Native browser install

\`\`\`
${inject(INSTALL_CMD_OPENCLAW)}
\`\`\`

Routes supported browser actions through Unbrowse while keeping browser fallback available. The package pulls in the local runtime automatically. Older OpenClaw builds may ask once to trust the plugin.

### CLI install

\`\`\`
${inject(setupOff)}
\`\`\`

This installs repo dependencies, prebuilds the packaged CLI runtime, installs a stable \`unbrowse\` shim, and starts the local server. During bootstrap, configure payouts if you want route-maintenance earnings to land in your wallet.

### Global install for daily use

\`\`\`
${inject(INSTALL_CMD_NPM)}
\`\`\`

### Upgrading

\`\`\`
unbrowse upgrade
\`\`\`

Codex and Claude installs also get a session-start update hint during \`unbrowse setup\`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| \`PORT\` | \`6969\` | Server port |
| \`HOST\` | \`127.0.0.1\` | Server bind address |
| \`UNBROWSE_URL\` | \`http://localhost:6969\` | Base URL used by the skill |
| \`UNBROWSE_API_KEY\` | (auto-generated) | Marketplace API key |
| \`UNBROWSE_API_URL\` | \`beta-api.unbrowse.ai\` | Backend API URL override |

## CLI Reference

### Core Workflow

\`\`\`
# Step 1: Resolve -- find what endpoints exist
unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty

# Step 2: Execute -- call a specific endpoint
unbrowse execute --skill {skill_id} --endpoint {endpoint_id} --pretty

# Step 3: Submit feedback (mandatory after resolve)
unbrowse feedback --skill {skill_id} --endpoint {endpoint_id} --rating 5 --outcome success
\`\`\`

### All Commands

| Command | Usage | Description |
|---------|-------|-------------|
| \`health\` | | Server health check |
| \`setup\` | \`[--opencode auto\\|global\\|project\\|off] [--no-start]\` | Bootstrap browser deps + Open Code command |
| \`resolve\` | \`--intent "..." --url "..." [opts]\` | Resolve intent: search/capture/execute |
| \`execute\` | \`--skill ID --endpoint ID [opts]\` | Execute a specific endpoint |
| \`feedback\` | \`--skill ID --endpoint ID --rating N\` | Submit feedback (mandatory after resolve) |
| \`review\` | \`--skill ID --endpoints '[...]'\` | Push reviewed descriptions/metadata back to skill |
| \`publish\` | \`--skill ID [--endpoints '[...]']\` | Describe + publish skill to marketplace |
| \`login\` | \`--url "..."\` | Interactive browser login |
| \`skills\` | | List all skills |
| \`skill\` | \`<id>\` | Get skill details |
| \`search\` | \`--intent "..." [--domain "..."]\` | Search marketplace |
| \`sessions\` | \`--domain "..." [--limit N]\` | Debug session logs |
| \`go\` | \`<url>\` | Navigate browser to URL (passive indexing) |
| \`snap\` | \`[--filter interactive]\` | A11y snapshot with @eN refs |
| \`click\` | \`<ref>\` | Click element by ref |
| \`fill\` | \`<ref> <value>\` | Fill input by ref |
| \`type\` | \`<text>\` | Type text with key events |
| \`press\` | \`<key>\` | Press key (Enter, Tab, Escape) |
| \`select\` | \`<ref> <value>\` | Select option by ref |
| \`scroll\` | \`[up\\|down\\|left\\|right]\` | Scroll the page |
| \`screenshot\` | | Capture screenshot (base64 PNG) |
| \`text\` | | Get page text content |
| \`markdown\` | | Get page as Markdown |
| \`cookies\` | | Get page cookies |
| \`eval\` | \`<expression>\` | Evaluate JavaScript |
| \`back\` | | Navigate back |
| \`forward\` | | Navigate forward |
| \`close\` | | Close browse session, flush + index traffic |

### Resolve/Execute Flags

| Flag | Description |
|------|-------------|
| \`--pretty\` | Indented JSON output |
| \`--schema\` | Show response schema + extraction hints only (no data) |
| \`--path "data.items[]"\` | Drill into result before output |
| \`--extract "field1,alias:deep.path"\` | Pick specific fields |
| \`--limit N\` | Cap array output to N items |
| \`--endpoint-id ID\` | Pick a specific endpoint |
| \`--dry-run\` | Preview mutations |
| \`--force-capture\` | Bypass caches, re-capture |
| \`--params '{...}'\` | Extra params as JSON |
| \`--raw\` | Return raw response data |

## Browser API (Playwright Replacement)

Agents can use Unbrowse as a drop-in replacement for Playwright:

\`\`\`typescript
import { Browser } from "unbrowse";

const browser = await Browser.launch();
const page = await browser.newPage();

// goto() resolves from skill cache first -- no browser tab if cached
const response = await page.goto("https://example.com/search?q=test");
const data = await response.json();

// Full Kuri browser API for uncached interactions
const tree = await page.snapshot();       // a11y tree with @eN refs
await page.click("e5");                   // click by ref
await page.fill("e3", "hello world");     // fill by ref
await page.press("Enter");
await page.screenshot();

// Content extraction
const html = await page.content();
const text = await page.text();
const md = await page.markdown();
const links = await page.links();

// DOM, cookies, HAR
await page.query("div.result");
const cookies = await page.cookies();
await page.harStart();
const har = await page.harStop();

await browser.close();
\`\`\`

### Full Page API

| Category | Methods |
|----------|---------|
| Navigation | \`goto(url)\`, \`goBack()\`, \`goForward()\`, \`reload()\`, \`url()\` |
| Content | \`content()\`, \`text()\`, \`markdown()\`, \`links()\`, \`snapshot(filter?)\` |
| Actions (ref) | \`click(ref)\`, \`fill(ref, value)\`, \`select(ref, value)\`, \`scroll()\`, \`scrollIntoView(ref)\`, \`drag(from, to)\`, \`press(key)\`, \`action(type, ref)\` |
| Keyboard | \`type(text)\`, \`insertText(text)\`, \`keyDown(key)\`, \`keyUp(key)\` |
| Wait | \`waitForSelector(css)\`, \`waitForLoad()\` |
| Evaluate | \`evaluate(fn)\` |
| DOM | \`query(css)\`, \`innerHTML(css)\`, \`attributes(ref)\`, \`findText(query)\` |
| Screenshots | \`screenshot()\` |
| Cookies/Auth | \`cookies()\`, \`setCookie(name, value)\`, \`setHeaders(headers)\` |
| HAR | \`harStart()\`, \`harStop()\`, \`networkEvents()\` |
| Viewport | \`setViewport(w, h)\`, \`setUserAgent(ua)\`, \`setCredentials(user, pass)\` |
| Session | \`sessionSave(name)\`, \`sessionLoad(name)\`, \`sessionList()\` |
| Debug | \`console()\`, \`errors()\`, \`injectScript(js)\` |

## REST API Reference

Local server at \`http://localhost:6969\`:

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| POST | \`/v1/intent/resolve\` | Resolve intent: search/capture/execute | Free (local) or Tier 3 (graph) |
| POST | \`/v1/skills/:id/execute\` | Execute a specific skill | Free (cached) or Tier 2 (opt-in site) |
| POST | \`/v1/auth/login\` | Interactive browser login | Free |
| POST | \`/v1/feedback\` | Submit feedback with diagnostics | Free |
| POST | \`/v1/search\` | Search marketplace globally | Tier 3 |
| POST | \`/v1/search/domain\` | Search marketplace by domain | Tier 3 |
| POST | \`/v1/graph/edges\` | Publish endpoint graph edges | Free |
| POST | \`/v1/transactions\` | Record a payment transaction | Free |
| POST | \`/v1/issues/auto-file\` | Auto-file a GitHub issue from error context | Free |
| GET | \`/v1/skills/:id\` | Get skill details | Free |
| GET | \`/v1/skills/:id/price\` | Get dynamic price for a skill | Free |
| PATCH | \`/v1/skills/:id\` | Update skill (set \`base_price_usd\`) | Free |
| GET | \`/v1/transactions/consumer/:agentId\` | Consumer payment history | Free |
| GET | \`/v1/transactions/creator/:agentId\` | Creator earnings history | Free |
| GET | \`/v1/sessions/:domain\` | Debug session logs | Free |
| GET | \`/health\` | Health check | Free |

## Payment Model

Capture, indexing, and route mapping are free. Agents pay per execution when reusing a paid route or running a paid search/resolve.

| Surface | When | What |
|---|---|---|
| Local execution from cache | A captured route is replayed locally | Free |
| Paid skill execution | Calling an opted-in priced route | Per-execute USDC settlement on Solana |
| Search / resolve over the shared marketplace | When the shortlist comes from the cloud marketplace | Per-query fee, USDC on Solana |
| Sponsored mode | New agents without a wallet, brand-new domains | Platform covers the first calls up to a daily allowance per agent and a platform-wide daily ceiling |

Payment is HTTP-native and inline: the server replies 402 with payment terms (the canonical [x402](https://www.x402.org) shape, kept as the developer-implementation appendix here); the client signs an off-chain Ed25519 authorization with a session key registered against their prepaid USDC escrow on [Faremeter Flex](https://docs.faremeter.xyz/flex/overview); the response carries the proof. EVM support is on Faremeter's roadmap; Unbrowse stays Solana-only for paid execute until then.

Wallet operations are delegated to pay.sh or any Solana-mainnet signer. Onboarding requires three artifacts on Solana mainnet: a wallet, a Flex escrow funded with USDC, and a registered session key. \`unbrowse setup\` walks through all three.

### Route Mining Economics

Agents earn by indexing the web for other agents. Every time an agent browses a new site through Kuri, Unbrowse captures the internal APIs and publishes them. When another agent reuses that route, the original contributor wallet gets paid — atomically, in USDC, in the same Solana transaction as the rest of the splits. Splits live natively in every signed authorization (90% to contributors, 10% to platform, 0% protocol fee, up to 5 recipients).

## Authentication

Unbrowse automatically uses your existing browser session. If you are logged into a site in Chrome, it just works.

For sites requiring explicit login:

\`\`\`
unbrowse login --url "https://example.com/login"
\`\`\`

The user completes login in the browser window. Cookies are stored in \`~/.unbrowse/profiles/<domain>/\` and reused automatically.

Built-in sign-in URL detection for: Google (Calendar, Drive, Gmail), Microsoft/Office 365, GitHub, Notion, LinkedIn, Twitter/X, Slack, Atlassian (Jira, Confluence), Salesforce, Figma, Airtable, Dropbox, and HubSpot.

## Use Cases

- **Web data extraction without browsers** -- extract structured data from any website via direct API calls, no DOM parsing needed
- **Price monitoring** -- track prices on e-commerce sites by calling their internal pricing APIs
- **Travel automation** -- search flights, hotels, and listings on Airbnb, Booking.com, etc. via their undocumented APIs
- **Social media integration** -- access X timelines, LinkedIn feeds, Reddit threads via their internal GraphQL and REST APIs
- **Agent tooling** -- give any AI agent instant access to website functionality without DOM interaction or token-heavy page scraping
- **Competitive intelligence** -- monitor competitor product pages, pricing, and inventory through their internal API routes
- **Route mining** -- earn revenue by browsing the web normally while Unbrowse indexes APIs for the shared marketplace

## Integrations

Works with any tool that supports CLI execution or the OpenClaw skill protocol. The recommended path is OpenClaw -- it makes Unbrowse the native browser so every page.goto() is accelerated automatically:

- **OpenClaw (recommended)** -- install via \`${inject(INSTALL_CMD_OPENCLAW)}\`
- **Claude Code** -- install via \`${inject(INSTALL_CMD_CLAUDE)}\`
- **Open Code** -- install via \`${inject(setupOff)}\`
- **Cursor** -- install via \`${inject(setupOff)}\`
- **Codex** -- install via \`${inject(INSTALL_CMD_CODEX)}\`
- **Windsurf** -- install via \`${inject(setupOff)}\`
- **Any CLI agent** -- call \`unbrowse resolve --intent "..." --url "..."\` directly

## Route Quality and Lifecycle

Routes in the shared graph follow a continuous trust model scored by three signals:

- **Execution feedback** -- per-endpoint reliability scores updated after each execution
- **Automated verification** -- background loop every 6 hours testing safe GET endpoints and checking for schema drift
- **Freshness decay** -- trust decays over time; routes not seen in weeks rank lower than routes verified yesterday

Skills move through a lifecycle: **active** (published, queryable) to **deprecated** (low reliability, ranked lower) to **disabled** (confirmed failures, removed until re-verified).

## Data Directories

| Path | Contents |
|------|----------|
| \`~/.unbrowse/profiles/<domain>/\` | Persistent browser profile (cookies, localStorage) |
| \`~/.unbrowse/config.json\` | Agent credentials and marketplace API key |
| \`~/.unbrowse/logs/\` | Daily debug logs |
| \`~/.unbrowse/skill-snapshots/\` | Cached skill manifests |
| \`~/.unbrowse/route-cache.json\` | Intent+URL to skill route cache (24h TTL) |
| \`~/.unbrowse/domain-skill-cache.json\` | Domain to skill mapping (7d TTL) |
| \`~/.unbrowse/traces/\` | Anonymized route trace artifacts |

## Links

- [Homepage](https://www.unbrowse.ai)
- [GitHub](https://github.com/unbrowse-ai/unbrowse)
- [npm](https://www.npmjs.com/package/unbrowse)
- [arXiv Paper](https://arxiv.org/abs/2604.00694)
- [Discord](https://discord.gg/VWugEeFNsG)
- [Skill Registry](https://www.unbrowse.ai/search)
`;

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Robots-Tag": "noindex",
      "X-Llms-Request-Id": requestId,
    },
  });
}
