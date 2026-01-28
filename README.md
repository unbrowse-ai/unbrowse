# Unbrowse

Self-learning skill generator for Clawdbot. Primarily reverse-engineers APIs by watching browser sessions and capturing network traffic. Also supports broader skill types — library integrations, workflows, and reusable agent knowledge. Skills are published to a cloud marketplace with Solana USDC payments.

## How It Works

```
Agent browses a website
        |
        v
CDP captures network requests
        |
        v
HAR parser extracts API endpoints + auth
        |
        v
Skill generator creates SKILL.md + auth.json + api.ts
        |
        v
Diff check — only writes if content changed
        |
        v
Saved to ~/.clawdbot/skills/<service>/
        |
        v
Auto-published to cloud marketplace (if wallet configured)
```

An agent using Clawdbot can browse any authenticated web app. Unbrowse silently captures API traffic in the background, identifies endpoints, extracts authentication, and generates a complete skill package. The agent (or other agents) can then replay those APIs without a browser.

Skills grow incrementally — each capture adds new endpoints to existing skills rather than overwriting. When a skill changes, it auto-republishes to the cloud marketplace so the latest knowledge is always available.

## Architecture

```
unbrowse/
  index.ts                 # Plugin entry — registers 10 tools with Clawdbot
  clawdbot.plugin.json     # Plugin config schema (UI hints, defaults)
  clawdbot.d.ts            # Type stubs for Clawdbot plugin SDK
  src/
    har-parser.ts          # HAR file → parsed endpoints + auth
    skill-generator.ts     # Parsed data → SKILL.md + auth.json + api.ts (diff-aware)
    auth-extractor.ts      # Detect auth method (Bearer, API Key, Cookie, Mudra)
    cdp-capture.ts         # Live network capture via browser CDP port
    stealth-browser.ts     # Cloud browser sessions via Browser Use SDK
    session-login.ts       # Credential-based login + capture
    auto-discover.ts       # Background hook — auto-generate + auto-publish skills
    skill-index.ts         # Cloud marketplace client (search, publish, download)
    skill-sanitizer.ts     # Strip credentials before publishing
    endpoint-tester.ts     # Validate GET endpoints with captured auth
    site-crawler.ts        # Crawl site to discover more API endpoints
    profile-capture.ts     # Network capture via Playwright CDP
    vault.ts               # Encrypted credential storage (SQLite + AES-256-GCM)
    credential-providers.ts # Opt-in login credential lookup (Keychain, 1Password, Vault)
    types.ts               # Shared type definitions
  server/
    src/
      index.ts             # Bun HTTP server (port 4402)
      db.ts                # SQLite database init
      schema.sql           # Skills, downloads, creator_earnings tables
      x402.ts              # Solana USDC payment protocol
      routes/
        search.ts          # GET /skills/search — full-text search (free)
        summary.ts         # GET /skills/:id/summary — skill detail (free)
        download.ts        # GET /skills/:id/download — x402 paywalled
        publish.ts         # POST /skills/publish — publish skill (free, upserts)
    web/
      src/
        main.tsx           # React 18 entry
        App.tsx             # Routes: / and /skills/:id
        pages/
          Home.tsx         # Skill search + grid
          SkillDetail.tsx  # Skill detail + download button
        context/
          WalletContext.tsx # Phantom wallet integration
        lib/
          api.ts           # API client + x402 payment flow
```

## Plugin Tools

Unbrowse registers 10 tools that the Clawdbot agent can call:

| Tool | Description |
|------|-------------|
| `unbrowse_learn` | Parse a HAR file and generate a skill |
| `unbrowse_capture` | Launch browser, visit URLs, capture API traffic, generate skill |
| `unbrowse_login` | Login with credentials via stealth/local browser, capture post-login APIs |
| `unbrowse_replay` | Execute API calls using captured auth (auto-refresh on 401) |
| `unbrowse_skills` | List all discovered/generated skills |
| `unbrowse_stealth` | Launch/manage cloud browser sessions (Browser Use) |
| `unbrowse_auth` | Extract auth tokens from browser via CDP |
| `unbrowse_publish` | Publish a skill to the cloud marketplace |
| `unbrowse_search` | Search and install skills from the cloud marketplace |
| `unbrowse_wallet` | Manage Solana wallet (auto-generate, set address, check status) |

### Auto-Discovery

When `autoDiscover` is enabled (default), Unbrowse hooks into `after_tool_call` on any browser tool. It silently monitors API traffic and generates skills when it sees 5+ requests to a new domain. A 30-second cooldown prevents spam.

For domains that already have a skill, 10+ new unique URLs trigger incremental re-generation — the skill grows over time as the agent discovers more endpoints.

### Incremental Learning + Auto-Publish

Skills are diff-aware. On every capture:

1. New `SKILL.md` content is compared against existing
2. Files are only written if content actually changed
3. A human-readable diff summary is generated (e.g. "+3 new endpoint(s)")
4. If the skill changed and a `creatorWallet` is configured, it auto-publishes to the cloud marketplace

This means skills grow incrementally across captures, and the cloud index always has the latest version.

### Auto-Wallet Setup

On first startup with no wallet configured, Unbrowse automatically:

1. Generates a Solana keypair
2. Saves the public key as `creatorWallet` (earning address)
3. Saves the private key as `skillIndexSolanaPrivateKey` (paying key)
4. Logs a message telling the user to fund the address with USDC

The user can also use the `unbrowse_wallet` tool to check status, generate a keypair manually, or import an existing wallet.

## Skill Types

While API reverse-engineering is the primary focus, skills can represent:

- **API Integrations** (primary) — Reverse-engineered endpoints with auth, captured from browser traffic
- **Library Wrappers** — How to use a library, with generated TypeScript client code
- **Workflows** — Multi-step processes combining multiple APIs or tools
- **Agent Knowledge** — Reusable patterns, configurations, or domain expertise

All skill types use the same package format (SKILL.md + supporting files) and can be published to the marketplace.

## Skill Package Format

Each generated skill produces a directory under `~/.clawdbot/skills/<service>/`:

```
zeemart-api/
  SKILL.md       # Human-readable API docs (endpoints, auth, examples)
  auth.json      # Extracted credentials (headers, cookies, auth method)
  scripts/
    api.ts       # TypeScript client class with typed methods per endpoint
  test.ts        # Test suite with example calls
  package.json   # Dependencies
```

### SKILL.md

Markdown documentation with:
- Service name, base URL, authentication method
- Endpoint table (method, path, description, status)
- Request/response examples from captured traffic
- Auth setup instructions

### auth.json

```json
{
  "service": "zeemart-api",
  "baseUrl": "https://api.zeemart.asia",
  "authMethod": "Bearer Token",
  "headers": { "Authorization": "Bearer eyJ..." },
  "cookies": { "session_id": "abc123" }
}
```

### api.ts

Generated TypeScript client:
```typescript
class ZeemartApiClient {
  constructor(private baseUrl: string, private headers: Record<string, string>) {}

  async getOrders(params?: { page?: number }) {
    return this.request('GET', '/api/v1/orders', { params });
  }

  async createOrder(body: { items: any[] }) {
    return this.request('POST', '/api/v1/orders', { body });
  }
}
```

## Browser Backends

Unbrowse supports multiple browser strategies via a smart cascade:

### Connection Cascade

1. **Clawdbot Managed Browser** (port 18791) — Persistent browser with accumulated sessions/cookies
2. **Chrome Debug Port** (9222/9229) — User's Chrome if started with `--remote-debugging-port`
3. **Fresh Playwright Chromium** — Clean browser, no profile (works for public pages or with `unbrowse_login`)

The cascade tries each in order, using the first available connection. For authenticated sites, use `unbrowse_login` to capture session credentials that persist across captures.

### Stealth Cloud (Browser Use)

Remote anti-detection browser via the [Browser Use SDK](https://docs.browser-use.com). Bypasses bot detection, supports proxies, returns a CDP URL for automation and a live URL for viewing.

```typescript
import { BrowserUseClient } from "browser-use-sdk";

const client = new BrowserUseClient({ apiKey });
const session = await client.browsers.createBrowserSession({
  timeout: 15,               // minutes (max 240)
  proxyCountryCode: "US",    // proxy location
  profileId: "...",          // reuse login state
});
// session.cdpUrl  → wss://... for Playwright/Puppeteer
// session.liveUrl → https://... shareable view
```

Requires a `browserUseApiKey` in plugin config.

## Cloud Marketplace

### Server

The skill index server runs on Bun (port 4402) with SQLite storage and optional x402 Solana USDC payments.

#### Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/health` | GET | None | Health check + x402 status |
| `/skills/search` | GET | None | Full-text search (`?q=`, `?tags=`, `?limit=`, `?offset=`) |
| `/skills/:id/summary` | GET | None | Skill metadata + endpoint list |
| `/skills/:id/download` | GET | x402 | Full skill package (SKILL.md + api.ts) |
| `/skills/publish` | POST | None | Publish a skill (upserts — version auto-increments) |

#### Database Schema

```sql
-- Main skill storage
skills (id, service, slug, version, base_url, auth_method_type,
        endpoints_json, skill_md, api_template, creator_wallet,
        download_count, tags, created_at, updated_at)

-- Full-text search (FTS5)
skills_fts (service, tags, base_url, skill_md)

-- Payment tracking per download
downloads (skill_id, payment_signature, payment_chain, payment_mint,
           payer_wallet, amount_usd, fee_payer_amount, creator_amount,
           treasury_amount)

-- Aggregated creator earnings
creator_earnings (creator_wallet, total_earned_usd, total_downloads,
                  pending_usd, last_download_at)
```

### Web Frontend

React 18 + Vite SPA served from the same Bun server. Skill browsing is free, downloads require Phantom wallet for x402 payment.

- **Home** (`/`): Search bar, skill grid with service name, auth type, endpoint count, download count, tags
- **Skill Detail** (`/skills/:id`): Full metadata, endpoint list with method badges, download button
- **Wallet**: Phantom integration via `window.solana` — connect only required for downloads

### x402 Payment Protocol

Downloads are gated by HTTP 402 using Solana USDC (SPL Token). The protocol uses a custom x402 smart contract for atomically verified payments.

#### Payment Flow

```
Client                              Server
  |                                   |
  |  GET /skills/:id/download         |
  |---------------------------------->|
  |                                   |
  |  402 { x402Version: 1, accepts }  |
  |<----------------------------------|
  |                                   |
  |  Build Solana tx:                 |
  |    - verify_payment (opcode 0)    |
  |    - SPL transfer(s)              |
  |    - settle_payment (opcode 1)    |
  |  Sign with wallet                 |
  |                                   |
  |  GET + X-Payment: <base64>        |
  |---------------------------------->|
  |                                   |
  |  Server verifies:                 |
  |    - Decode transaction           |
  |    - Simulate on Solana           |
  |    - Check x402 instructions      |
  |    - Verify amount >= expected    |
  |    - Submit + confirm             |
  |                                   |
  |  200 { skillMd, apiTemplate }     |
  |<----------------------------------|
```

#### 4-Party Payment Split

Every download payment is split between four recipients:

| Recipient | Share | Address |
|-----------|-------|---------|
| Fee Payer | 2% + gas (2000 USDC lamports) | `8XLmbY...` (fixed) |
| Skill Creator | 3% | From `creator_wallet` on skill record |
| FDRY Treasury | 30% | `FDRY_TREASURY_WALLET` env var |
| Website Owner | 65% | Treasury (until domain verification) |

Unclaimed shares (no creator wallet, no website owner) are consolidated into the FDRY Treasury recipient.

#### 402 Response Format

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "solana-devnet",
    "maxAmountRequired": "10000",
    "resource": "https://skills.unbrowse.ai/skills/abc/download",
    "description": "Download skill package abc",
    "mimeType": "application/json",
    "payTo": "<treasury-address>",
    "maxTimeoutSeconds": 60,
    "asset": "<USDC-mint-address>",
    "outputSchema": { "..." : "..." },
    "extra": {
      "feePayer": "<fee-payer-address>",
      "costCents": 1,
      "costUsd": 0.01,
      "programId": "<x402-program-id>"
    }
  }]
}
```

#### Transaction Structure

The x402 Solana transaction contains three instructions:

1. **verify_payment** (opcode 0): x402 program instruction encoding `amount` (u64 LE) and `nonce` (u64 LE) at byte offset 1
2. **SPL Token transfer(s)**: USDC transfers to each recipient per the split
3. **settle_payment** (opcode 1): x402 program instruction with matching `nonce` (u64 LE)

Server verification:
- Parse as legacy `Transaction` (fallback: `VersionedTransaction`)
- Simulate via `connection.simulateTransaction()`
- Decode x402 program instructions (opcode 0 = verify, opcode 1 = settle)
- Check `verifyPaymentAmount >= sum(expectedRecipients)`
- Submit and await confirmation

#### Configuration

| Env Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `USDC_MINT` | `4zMMC9...` (devnet) | USDC SPL token mint address |
| `FDRY_TREASURY_WALLET` | _(none — disables x402)_ | Treasury wallet for receiving payments |
| `DOWNLOAD_PRICE_CENTS` | `1.0` | Price per download in USD cents |
| `PORT` | `4402` | Server listen port |
| `DB_PATH` | `./skills.db` | SQLite database path |

When `FDRY_TREASURY_WALLET` is not set, downloads are free (dev mode).

## Plugin Configuration

Configured via `clawdbot.plugin.json` schema, stored in `~/.clawdbot/clawdbot.json` under `plugins.entries.unbrowse.config`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `skillsOutputDir` | string | `~/.clawdbot/skills` | Local skill storage directory |
| `browserPort` | number | `18791` | CDP browser control port |
| `browserUseApiKey` | string | _(none)_ | Browser Use API key for stealth cloud browsers |
| `autoDiscover` | boolean | `true` | Auto-generate skills when agent browses |
| `skillIndexUrl` | string | `https://skills.unbrowse.ai` | Cloud marketplace API URL |
| `creatorWallet` | string | _(auto-generated)_ | Solana wallet for receiving download payments |
| `skillIndexSolanaPrivateKey` | string | _(auto-generated)_ | Solana private key for paying x402 downloads |
| `credentialSource` | string | `none` | Opt-in login credential lookup: `auto`, `keychain`, `1password`, `vault`, or `none` |

**Wallet auto-setup:** If neither `creatorWallet` nor `skillIndexSolanaPrivateKey` is configured, a Solana keypair is automatically generated on first startup. The public key is saved as the creator wallet (earning address), and the private key is saved for paying marketplace downloads. Fund the wallet with USDC to start discovering skills.

### Credential Auto-Login

When `credentialSource` is set, `unbrowse_login` can auto-fill login forms by looking up stored passwords — no need to paste credentials into the tool call.

| Source | Backend | Requirements |
|--------|---------|--------------|
| `auto` | Auto-detect | Tries keychain → 1password → vault in order, uses the first available. Recommended. |
| `keychain` | macOS Keychain | macOS only. Reads passwords saved by Safari and system apps via `security` CLI. |
| `1password` | 1Password CLI | `op` CLI installed and signed in (`op signin`). Searches Login items by URL. |
| `vault` | Local encrypted vault | Uses the same AES-256-GCM encrypted SQLite vault as API auth. Stores username/password per domain. |

**Security:** This is a config-only setting — it cannot be enabled by a tool call or by the agent. The user must explicitly opt in via plugin settings. This prevents the agent from autonomously accessing your password manager.

**How it works:**

1. Agent calls `unbrowse_login` with just a `loginUrl` (no `formFields`)
2. Unbrowse extracts the domain from the URL
3. Credential provider looks up matching login credentials
4. If found, auto-builds form field selectors (email/username + password inputs)
5. Playwright fills and submits the form automatically
6. Session cookies and auth headers are captured as usual

The agent never sees raw passwords in tool call parameters — they flow directly from the credential source into Playwright's form fill. Set `autoFillFromProvider: false` on a specific login call to skip auto-lookup.

## Setup

### Plugin (Clawdbot extension)

```bash
cd extensions/unbrowse
npm install
```

The plugin is loaded by Clawdbot automatically from the `clawdbot.extensions` field in `package.json`.

### Server

```bash
cd extensions/unbrowse/server
bun install

# Dev mode (free downloads, no payment verification)
bun run dev

# Production (with x402 payments)
FDRY_TREASURY_WALLET=<solana-address> \
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
bun run start
```

### Web Frontend

```bash
cd extensions/unbrowse/server/web
npm install
npm run build    # builds to dist/ — served by Bun server

# Or for development with hot reload:
npm run dev      # Vite dev server on port 3000, proxies API to :4402
```

## Dependencies

### Plugin
- `playwright` — local browser automation + CDP
- `browser-use-sdk` — stealth cloud browser sessions
- `@solana/web3.js` + `@solana/spl-token` — Solana x402 client payments
- `bs58` — base58 encoding for Solana keys

### Server
- `bun` (runtime) — HTTP server + SQLite
- `@solana/web3.js` + `@solana/spl-token` — x402 payment verification

### Web Frontend
- `react` + `react-dom` + `react-router-dom` — SPA framework
- `@solana/web3.js` + `@solana/spl-token` — Phantom wallet x402 payments
- `vite` — build tooling
