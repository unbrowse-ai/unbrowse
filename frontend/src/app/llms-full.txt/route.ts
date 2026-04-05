import { NextResponse } from "next/server";
import {
  INSTALL_CMD_CLAUDE,
  INSTALL_CMD_CODEX,
  INSTALL_CMD_MCP,
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
  const setupMcp = `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/unbrowse && cd ~/unbrowse && ./setup --host mcp`;

  const body = `# Unbrowse

> Unbrowse is an open-source tool that reverse-engineers the internal APIs (shadow APIs) behind any website, letting AI agents make direct API calls instead of automating headless browsers. It reduces interaction time from 5-30 seconds to sub-100ms cached responses and cuts token usage from ~8,000 to ~200 tokens per action. Skills discovered by one agent are published to a shared marketplace for all agents to reuse.

## Product Description

Unbrowse is the intelligence layer on top of Kuri, a 464KB Zig-native CDP (Chrome DevTools Protocol) broker with ~3ms cold start. Together they form an API-native agent browser: Kuri handles raw browser automation, and Unbrowse watches what Kuri does, learns the internal APIs that every website exposes behind its UI, and progressively replaces browser calls with direct API calls.

The core insight is that every modern website is a thin UI layer over internal APIs -- REST endpoints, GraphQL queries, RPC calls. These "shadow APIs" are undocumented but fully functional. Unbrowse captures network traffic during normal browsing, reverse-engineers these APIs into reusable skills (structured endpoint definitions with schemas, auth patterns, and parameter bindings), and publishes them to a shared marketplace. One agent learns a site once; every later agent gets the fast path.

Agents use Unbrowse as a drop-in replacement for Playwright or Puppeteer. Under the hood, \`page.goto()\` checks the skill cache first -- if a cached internal API route exists, it returns structured JSON data in under 200ms without opening a browser tab. On cache miss, Kuri navigates normally while Unbrowse captures traffic in the background and indexes it for future reuse.

The whitepaper "Internal APIs Are All You Need" (Tham, Garcia & Hahn, 2026) formalizes the three-path execution model, the shared route graph, and the x402 micropayment protocol. Available at https://arxiv.org/abs/2604.00694.

## Architecture Overview

### Three Execution Paths

1. **Skill cache (Path 1)** -- instant, under 200ms. A cached internal API route is executed directly. No browser launch, no network navigation. The agent gets structured JSON data.

2. **Shared route graph (Path 2)** -- sub-second. A route discovered by another agent is served from the collectively maintained marketplace. The agent installs the skill once (Tier 1 payment) and executes locally thereafter.

3. **Kuri browser fallback (Path 3)** -- 20-80 seconds. Full browser session via Kuri. Unbrowse captures and indexes all traffic in the background for future acceleration. This is the slow path that trains the fast path.

### Seven-Layer Cache Resolution

When an agent asks for something, Unbrowse checks seven layers before touching the network:

1. In-memory result cache (exact match)
2. Route cache (persisted, 24h TTL)
3. Domain skill cache (persisted, 7d TTL)
4. Local skill snapshots (disk scan)
5. Marketplace semantic search (remote)
6. First-pass browser action (lightweight 8s attempt)
7. Live capture (full browser, last resort)

### Six-Layer Pipeline

1. **Passive capture** -- every network API call is intercepted and recorded during browsing. A JS interceptor is injected via \`Page.addScriptToEvaluateOnNewDocument\` so early SPA hydration calls are never missed.

2. **Background indexing** -- captured traffic is reverse-engineered into API endpoints without blocking the agent. The indexer extracts endpoints, builds an operation graph, and writes results to a local skill cache.

3. **Cache-first resolution** -- the seven-layer resolution stack described above.

4. **Browser replacement API** -- drop-in Playwright replacement where \`page.goto()\` resolves from skill cache first.

5. **Endpoint graph** -- endpoints are connected in a dependency graph with typed edges: parent/child (list to detail), pagination (cursor chains), and auth dependencies.

6. **Marketplace and payments** -- every learned skill is published to the shared marketplace. Skills are discoverable by semantic vector search. x402 micropayments handle paid routes.

### System Components

- **Local server** (\`localhost:6969\`) -- handles intent resolution, browser capture, skill execution, auth management, background indexing, and payment gates.
- **Backend API** (\`beta-api.unbrowse.ai\`) -- Cloudflare Worker powering the shared marketplace: KV-backed skill storage, Gemini embedding vector search (1536-dim, EmergentDB), EMA-based reliability scoring, Unkey agent registration, endpoint graph, and transaction ledger.
- **Kuri** -- Zig-native CDP broker. 464KB binary. ~3ms cold start. 80+ HTTP endpoints covering navigation, snapshots, ref-based actions, HAR recording, cookies, screenshots, DOM queries, security testing, video recording, tracing, and profiling.

## Key Stats and Benchmarks

- **3.6x mean speedup** over Playwright across 94 live production domains
- **5.4x median speedup** -- the median case is even faster because cached routes dominate
- **18 domains** completed in sub-100ms from cached skill routes
- **Under 200ms** cached route execution -- no browser launch, no rendering
- **464KB** Kuri binary size (Zig-native, statically linked)
- **~3ms** Kuri cold start time
- **~200 tokens** per action (vs ~8,000 tokens for DOM-based browser automation)
- **94 domains** benchmarked in the whitepaper evaluation
- **Seven layers** of cache resolution before touching the network
- **AGPL-3.0** open-source license

## Installation

### Native browser install (recommended)

\`\`\`
${inject(INSTALL_CMD_OPENCLAW)}
\`\`\`

Makes Unbrowse the default browser for your agent. Every \`page.goto()\` routes through Unbrowse automatically — no code changes needed. The package pulls in the local runtime automatically. Older OpenClaw builds may ask once to trust the plugin.

### CLI install

\`\`\`
${inject(setupOff)}
\`\`\`

This installs repo dependencies, prebuilds the packaged CLI runtime, installs a stable \`unbrowse\` shim, and starts the local server. During bootstrap, set up Crossmint lobster.cash if you want mined-route payouts to land in your wallet.

### Generic MCP host install

\`\`\`
${inject(setupMcp)}
\`\`\`

This writes a ready-to-import MCP config to \`~/.config/unbrowse/mcp/unbrowse.json\`. A generic template is published at \`https://www.unbrowse.ai/mcp.json\`.

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
| POST | \`/v1/auth/steal\` | Import cookies from browser/Electron storage | Free |
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

Capture, indexing, and reverse-engineering are free. Agents pay only when using the shared graph to skip discovery.

| Tier | What | When | Cost |
|------|------|------|------|
| Free | Capture, reverse-engineer, execute from local cache | Always | $0 |
| Tier 1 | Skill install from marketplace (one-time) | First use of a shared route | $0.005-0.02 |
| Tier 2 | Per-execution site owner fee (opt-in) | Each call to an opted-in site | $0.001-0.01 |
| Tier 3 | Search/routing fee (per-query) | Each marketplace graph lookup | $0.001-0.005 |

Tier 1 is one-time: pay once, execute locally forever with no further marketplace payments. Tier 2 only applies to sites whose owners have opted in to per-execution pricing. Tier 3 covers the cost of maintaining the shared index and serving vector search.

Payment uses the x402 protocol. Paid skills return HTTP 402 with payment requirements. Supported chains: Solana (USDC) and Base (USDC) via the Corbits facilitator. Wallet operations are delegated to lobster.cash. Creator payout wallets are synced from agent registration/runtime wallet state. Current payout policy is single-recipient: the majority contributor wallet wins, with first-contributor winning ties. That winner wallet must already be Solana mainnet USDC-ready or settlement can fail. Publish-time Cascade provisioning still accepts either a pre-made \`UNBROWSE_CASCADE_SPLIT_ADDRESS\`/\`UNBROWSE_CASCADE_SPLIT_CONFIG\` override or the signer/RPC env needed to call \`@cascade-fyi/splits-sdk\`.

For new installs, treat Crossmint lobster.cash setup as part of earning setup, not an optional extra. Without a configured wallet, the agent can still index routes but payout flow cannot land earnings to the contributor.

Worker payment gating is controlled by \`PAYMENTS_ENABLED\`; when false, search and skill x402 gates are bypassed and no search fees are recorded.

### Route Mining Economics

Agents earn by indexing the web for other agents. Every time an agent browses a new site through Kuri, Unbrowse captures the internal APIs and publishes them. When another agent installs that route (Tier 1), the original discoverer gets paid. Attribution is delta-based: each contributor's share is proportional to their marginal contribution to route quality. The backend transaction ledger fans paid executions out across contributor earnings using those shares, even before a multi-party split recipient is provisioned on-chain.

## Authentication

Unbrowse automatically extracts cookies from your Chrome/Firefox SQLite database. If you are logged into a site in Chrome, it just works.

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
- **Competitive intelligence** -- monitor competitor product pages, pricing, and inventory through their shadow APIs
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
- **Freshness decay** -- trust decays over time: \`freshness = 1/(1 + days_since_update/30)\`

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
