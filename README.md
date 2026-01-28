# Unbrowse

Self-learning browser agent for Clawdbot. Watches browser traffic, captures API calls as HAR, and turns them into reusable skills. When an API needs to be called again, it replays through the browser — proxying requests with the right auth, cookies, and session state.

## Core Loop

```
Browse a website (interact, capture, or auto-discover)
        |
        v
Capture XHR/fetch traffic as HAR entries
        |
        v
Parse endpoints + auth + cookies + session state
        |
        v
Generate skill: SKILL.md + auth.json + api.ts
        |
        v
Next time: replay APIs through browser proxy (unbrowse_replay)
        |
        v
Auth expired? Auto-refresh via unbrowse_login → retry
```

The key insight: **every API call the agent discovers gets recorded and replayed**. The browser is the capture device *and* the execution proxy. Skills accumulate incrementally — each interaction adds new endpoints to existing skills.

## How Skills Are Created

Skills come from three sources, all producing the same output:

1. **Auto-discover** — Background hook watches any `browser*` tool calls. When 5+ API calls hit a new domain, a skill is auto-generated. Silent, zero-config.

2. **unbrowse_capture** — Point it at URLs, it launches a browser, crawls same-domain links, discovers OpenAPI specs, captures all traffic, tests GET endpoints, and generates a skill.

3. **unbrowse_interact** — Browser-use-style page interaction. Agent clicks buttons, fills forms, navigates flows (like booking a restaurant). All XHR/fetch traffic is captured as full HAR entries and fed into skill generation automatically.

All three produce the same skill package: `SKILL.md` + `auth.json` + `api.ts`.

## How APIs Are Replayed

`unbrowse_replay` executes API calls using captured auth. It works two ways:

- **Fetch mode** — Direct HTTP with cookies and headers from `auth.json`. Accumulates `Set-Cookie` and session headers between sequential calls. Fast.
- **Browser mode** — Opens Playwright, injects cookies/headers/localStorage/sessionStorage, executes in-page. For SPAs that need client-side JS context.

Session state persists across tool calls — cookies, headers, localStorage, and sessionStorage are written back to `auth.json` after every replay. Cookie expiry (Max-Age, Expires) is respected.

On 401, unbrowse_replay automatically re-runs `unbrowse_login` to refresh the session, then retries.

## Browser Interaction (browser-use style)

`unbrowse_interact` lets the agent drive pages autonomously — no manual interaction needed. After navigating, it extracts all interactive elements and assigns numeric indices:

```
[1] <button> Book Now
[2] <input type="text" placeholder="Search restaurants">
[3] <select name="guests"> options=[1, 2, 3, 4, 5+]
[4] <a href="/reservations"> My Reservations
```

The agent references elements by index:

| Action | Example | Description |
|--------|---------|-------------|
| `click_element` | `index=1` | Click by element index |
| `input_text` | `index=2, text="Italian"` | Type into input by index |
| `select_option` | `index=3, text="2"` | Select dropdown option |
| `get_dropdown_options` | `index=3` | List available options |
| `scroll` | `direction="down", amount=2` | Scroll by pages |
| `send_keys` | `text="Enter"` | Keyboard input |
| `extract_content` | — | Read full page text |
| `go_to_url` | `text="https://..."` | Navigate to URL |
| `go_back` | — | Browser back |
| `wait` | `selector=".loaded"` | Wait for element |
| `done` | `text="Booking confirmed"` | Signal completion |

Page state is re-extracted after every mutating action so indices stay current. CSS selector fallback is available when indices aren't enough.

All XHR/fetch traffic during interaction is captured as full HAR (headers, cookies, request/response bodies) and auto-fed into skill generation.

## Architecture

```
unbrowse/
  index.ts                 # Plugin entry — registers 11 tools with Clawdbot
  clawdbot.plugin.json     # Plugin config schema (UI hints, defaults)
  src/
    dom-service.ts         # Browser-use-style DOM extraction + element indexing
    har-parser.ts          # HAR file → parsed endpoints + auth
    skill-generator.ts     # Parsed data → SKILL.md + auth.json + api.ts (diff-aware)
    auth-extractor.ts      # Detect auth method (Bearer, API Key, Cookie, Mudra)
    cdp-capture.ts         # Live network capture via browser CDP port
    stealth-browser.ts     # Cloud browser sessions via Browser Use SDK
    session-login.ts       # Credential-based login + capture (cookies, headers, localStorage, sessionStorage, meta tokens)
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
      schema.sql           # Skills, downloads, creator_earnings, review columns
      skill-review.ts      # Two-layer safety review (static regex + LLM) for supply chain attack prevention
      x402.ts              # Solana USDC payment protocol
      routes/
        search.ts          # GET /skills/search — full-text search (only approved skills)
        summary.ts         # GET /skills/:id/summary — skill detail
        download.ts        # GET /skills/:id/download — x402 paywalled, approved-only
        publish.ts         # POST /skills/publish — publish skill (static pre-screen + async LLM review)
```

## Plugin Tools

| Tool | Description |
|------|-------------|
| `unbrowse_capture` | Launch browser, visit URLs, crawl, capture API traffic, generate skill |
| `unbrowse_replay` | Execute API calls using captured auth (auto-refresh on 401) |
| `unbrowse_interact` | Browser-use-style page interaction — click, fill, select by element index. Auto-generates skills from captured traffic. |
| `unbrowse_login` | Login with credentials via Playwright, capture session (cookies, headers, localStorage, sessionStorage) |
| `unbrowse_learn` | Parse a HAR file and generate a skill |
| `unbrowse_skills` | List all discovered/generated skills |
| `unbrowse_stealth` | Launch/manage stealth cloud browser sessions (API execution only) |
| `unbrowse_auth` | Extract auth tokens from browser via CDP |
| `unbrowse_publish` | Publish a skill to the cloud marketplace |
| `unbrowse_search` | Search and install skills from the cloud marketplace |
| `unbrowse_wallet` | Manage Solana wallet (auto-generate, set address, check status) |

## Session Persistence

Auth state persists across tool calls via `auth.json`:

```json
{
  "service": "eatigo",
  "baseUrl": "https://eatigo.com",
  "authMethod": "Cookie + Bearer Token",
  "headers": { "Authorization": "Bearer eyJ...", "x-csrf-token": "abc" },
  "cookies": { "session_id": "xyz", "auth_token": "..." },
  "localStorage": { "access_token": "eyJ...", "user_id": "123" },
  "sessionStorage": { "csrf": "abc" },
  "lastReplayAt": "2026-01-28T05:00:00.000Z"
}
```

After every `unbrowse_replay` or `unbrowse_interact`:
- New `Set-Cookie` headers are accumulated (expired cookies deleted via Max-Age/Expires)
- Session response headers (x-csrf-token, authorization, etc.) are captured
- localStorage/sessionStorage auth entries are re-extracted from the browser
- Everything is written back to `auth.json`

This means multi-step API flows (check availability -> select timeslot -> confirm booking) work across separate tool calls with no session loss.

## Credential Auto-Login

When `credentialSource` is configured, `unbrowse_login` can auto-fill login forms by looking up stored passwords.

| Source | Backend | Requirements |
|--------|---------|--------------|
| `auto` | Auto-detect | Tries keychain -> 1password -> vault, uses first available |
| `keychain` | macOS Keychain | macOS only, reads Safari/system passwords via `security` CLI |
| `1password` | 1Password CLI | `op` CLI installed and signed in |
| `vault` | Local encrypted vault | AES-256-GCM encrypted SQLite, stores username/password per domain |

This is a **config-only setting** — cannot be enabled by the agent or a tool call. Prevents autonomous password manager access.

## Skill Safety Review

Skills published to the cloud marketplace go through a two-layer safety review:

1. **Static scan** (instant) — 25+ regex patterns for shell exec, SSH/AWS key access, eval, prompt injection, exfil domains, crypto mining. Blocks obvious attacks immediately (422).

2. **LLM review** (async) — Claude Sonnet or GPT-4o-mini analyzes skill code for subtle supply chain attacks: data exfiltration, credential harvesting, obfuscated payloads, prompt injection.

Skills are `pending` until reviewed. Only `approved` skills are downloadable and appear in search results. Rejected/flagged skills return 403.

## Skill Package Format

```
eatigo/
  SKILL.md       # Human-readable API docs (endpoints, auth, examples)
  auth.json      # Session state (headers, cookies, localStorage, sessionStorage)
  scripts/
    api.ts       # TypeScript client class with typed methods per endpoint
  test.ts        # Test suite with example calls
  package.json   # Dependencies
```

## Cloud Marketplace

### Server

The skill index server runs on Bun (port 4402) with SQLite storage and x402 Solana USDC payments.

#### Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/health` | GET | None | Health check + x402 status |
| `/skills/search` | GET | None | Full-text search (`?q=`, `?tags=`, `?limit=`, `?offset=`). Only shows approved skills. |
| `/skills/:id/summary` | GET | None | Skill metadata + endpoint list |
| `/skills/:id/download` | GET | x402 | Full skill package (SKILL.md + api.ts). Approved-only. |
| `/skills/publish` | POST | None | Publish a skill (upserts — version auto-increments, triggers safety review) |

#### Database Schema

```sql
-- Main skill storage
skills (id, service, slug, version, base_url, auth_method_type,
        endpoints_json, skill_md, api_template, creator_wallet,
        download_count, tags, review_status, review_reason,
        review_flags, review_score, reviewed_at, created_at, updated_at)

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

| Recipient | Share | Address |
|-----------|-------|---------|
| Fee Payer | 2% + gas (2000 USDC lamports) | `8XLmbY...` (fixed) |
| Skill Creator | 3% | From `creator_wallet` on skill record |
| FDRY Treasury | 30% | `FDRY_TREASURY_WALLET` env var |
| Website Owner | 65% | Treasury (until domain verification) |

Unclaimed shares (no creator wallet, no website owner) are consolidated into the FDRY Treasury.

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

#### Server Configuration

| Env Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `USDC_MINT` | `4zMMC9...` (devnet) | USDC SPL token mint address |
| `FDRY_TREASURY_WALLET` | _(none — disables x402)_ | Treasury wallet for receiving payments |
| `DOWNLOAD_PRICE_CENTS` | `1.0` | Price per download in USD cents |
| `PORT` | `4402` | Server listen port |
| `DB_PATH` | `./skills.db` | SQLite database path |

When `FDRY_TREASURY_WALLET` is not set, downloads are free (dev mode).

### Auto-Wallet Setup

On first startup with no wallet configured, Unbrowse automatically generates a Solana keypair, saves the public key as `creatorWallet` (earning address) and the private key as `skillIndexSolanaPrivateKey` (paying key). Fund the address with USDC to start downloading and earning from skills.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `skillsOutputDir` | string | `~/.clawdbot/skills` | Local skill storage directory |
| `browserPort` | number | `18791` | CDP browser control port |
| `browserUseApiKey` | string | — | Browser Use API key for stealth cloud browsers |
| `autoDiscover` | boolean | `true` | Auto-generate skills when agent browses |
| `skillIndexUrl` | string | `https://skills.unbrowse.ai` | Cloud marketplace API URL |
| `creatorWallet` | string | _(auto-generated)_ | Solana wallet for download payments |
| `skillIndexSolanaPrivateKey` | string | _(auto-generated)_ | Solana private key for paying downloads |
| `credentialSource` | string | `none` | Credential lookup: `auto`, `keychain`, `1password`, `vault`, `none` |

## Setup

```bash
cd extensions/unbrowse
bun install

# Server (optional — for cloud marketplace)
cd server && bun install
FDRY_TREASURY_WALLET=<address> bun run start
```
