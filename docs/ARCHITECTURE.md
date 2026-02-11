# Unbrowse Architecture

> Browse once. Automate forever.

Unbrowse is a self-learning browser agent that captures API traffic from websites and turns it into reusable "skills." When an API needs to be called again, it replays through direct HTTP—no browser screenshots, no clicking, no waiting.

## Table of Contents

1. [Core Concept](#core-concept)
2. [Data Flow](#data-flow)
3. [Tools Reference](#tools-reference)
4. [Skill Generation Pipeline](#skill-generation-pipeline)
5. [Authentication Handling](#authentication-handling)
6. [Browser Connection Strategies](#browser-connection-strategies)
7. [Marketplace & Payments](#marketplace--payments)
8. [Configuration](#configuration)

---

## Core Concept

The key insight: **every API call the agent discovers gets recorded and replayed**. The browser is the capture device; direct HTTP is the execution layer.

```
You browse a website
        ↓
Unbrowse captures all API calls (HAR format)
        ↓
Generates a "skill": SKILL.md + auth.json + api.ts
        ↓
Next time: replay APIs directly—0.3 seconds, 95% reliable
        ↓
Auth expired? Auto-refresh via login flow → retry
```

### What is a Skill?

A skill is a learned API integration consisting of:

| File | Purpose |
|------|---------|
| `SKILL.md` | Human-readable endpoint documentation |
| `auth.json` | Stored credentials (headers, cookies, tokens) |
| `scripts/api.ts` | Generated TypeScript client |

Skills are stored in `~/.clawdbot/skills/<service-name>/` by default.

---

## Data Flow

```
URL Input
  ↓
[unbrowse_capture / unbrowse_login / unbrowse_interact]
  ↓
Browser Launch (CDP / Playwright / BrowserBase)
  ↓
Network Traffic Capture (HAR format)
  ↓
parseHar() → Extract endpoints, auth headers, cookies
  ↓
  ├→ Detect refresh token patterns
  ├→ Auto-test GET endpoints
  └→ Merge OpenAPI specs if found
  ↓
generateSkill() → SKILL.md + auth.json + api.ts
  ↓
  ├→ Auto-publish to marketplace (if wallet configured)
  └→ Store credentials in encrypted vault
  ↓
[unbrowse_replay executes APIs]
  ↓
  ├→ Load auth from auth.json / vault
  ├→ Execute via direct fetch or stealth browser
  ├→ Auto-refresh on 401/403
  └→ Accumulate new session tokens
```

---

## Tools Reference

### unbrowse_capture

**Capture API traffic from any website automatically.**

```typescript
{
  urls: string[]           // Required: URLs to visit
  outputDir?: string       // Skill save location (default: ~/.clawdbot/skills)
  waitMs?: number          // Wait time per page (default: 5000ms)
  crawl?: boolean          // Auto-crawl same-domain links (default: true)
  maxPages?: number        // Max pages to crawl (default: 15)
  testEndpoints?: boolean  // Auto-test GET endpoints (default: true)
}
```

**Process:**
1. Launches browser (no user action needed)
2. Visits seed URLs, captures XHR/Fetch traffic
3. Crawls site to discover more endpoints
4. Detects OpenAPI/Swagger specs
5. Auto-tests GET endpoints to verify
6. Generates skill files
7. Auto-publishes if wallet configured

---

### unbrowse_replay

**Execute API calls using stored credentials.**

```typescript
{
  service: string          // Required: skill name
  endpoint?: string        // Specific endpoint (e.g., "GET /api/users")
  body?: string            // JSON body for POST/PUT/PATCH
  useStealth?: boolean     // Force stealth cloud browser
  proxyCountry?: string    // Proxy country code ("us", "gb", etc.)
}
```

**Execution cascade:**
1. Try direct fetch with stored headers/cookies
2. Try Chrome profile (live session cookies)
3. On 401/403: auto-refresh credentials
4. On 403/429: fall back to stealth browser

**Auth handling:**
- Loads cookies, headers, localStorage/sessionStorage from auth.json
- Promotes JWTs to Authorization headers automatically
- Accumulates Set-Cookie headers across requests
- Persists updated auth state back to auth.json

---

### unbrowse_login

**Log in with credentials and capture session state.**

```typescript
{
  loginUrl: string                    // Required: login page URL
  service?: string                    // Service name (auto-derived if omitted)
  formFields?: Record<string, string> // CSS selector → value pairs
  submitSelector?: string             // Submit button selector (auto-detected)
  headers?: Record<string, string>    // Headers to inject
  cookies?: Array<{name, value, domain}> // Pre-set cookies
  captureUrls?: string[]              // URLs to visit after login
  autoFillFromProvider?: boolean      // Auto-lookup from keychain/1password
  saveCredentials?: boolean           // Save to vault after login
}
```

**Process:**
1. Resolves credentials from provider (keychain, 1password, vault)
2. Launches browser (stealth cloud or local Playwright)
3. Navigates to login URL
4. Auto-fills form with credentials
5. Submits and waits for post-login redirect
6. Extracts cookies, auth headers, localStorage/sessionStorage
7. Saves to auth.json and encrypted vault
8. Optionally generates skill from captured traffic

---

### unbrowse_interact

**Drive browser pages with index-based element targeting.**

```typescript
{
  url: string              // Required: URL to navigate to
  service?: string         // Service name for auth loading
  actions: Array<Action>   // Browser actions to perform
  captureTraffic?: boolean // Capture API calls (default: true)
}

// Available actions:
click_element(index)              // Click by element index
input_text(index, text, clear?)   // Type into field
select_option(index, text)        // Select dropdown option
get_dropdown_options(index)       // List dropdown values
scroll(direction, amount)         // Scroll page
send_keys(text)                   // Keyboard input ("Enter")
wait(selector | ms)               // Wait for element or time
extract_content()                 // Extract page text
go_to_url(url)                    // Navigate
go_back()                         // Navigate back
done()                            // End session
```

**Page state format:**
```
[1] <button> Submit
[2] <input type="email" placeholder="Email">
[3] <a href="/dashboard"> Dashboard
[4] <select name="country"> options=[USA, UK, Canada]
```

Use element indices for targeting (avoids CSS selector fragility).

---

### unbrowse_learn

**Parse HAR file to generate skill.**

```typescript
{
  harPath?: string   // Path to HAR file
  harJson?: string   // Inline HAR JSON (alternative)
  outputDir?: string // Skill save location
}
```

---

### unbrowse_skills

**List all discovered skills.**

Returns: Local skills with endpoint counts and auth methods.

---

### unbrowse_stealth

**Launch cloud browser with anti-bot detection.**

```typescript
{
  action: "start" | "stop" | "capture" | "status"
  url?: string           // URL for capture action
  timeout?: number       // Session timeout in minutes (default: 15)
  proxyCountry?: string  // Proxy country ("US", "GB", "SG")
  sessionId?: string     // Required for stop/capture/status
}
```

**Use cases:**
- Sites with anti-bot protection
- Geo-restricted content
- CAPTCHA/Cloudflare challenges

**Returns:** Session ID, CDP URL (for Playwright), live view URL

---

### unbrowse_publish

**Publish skill to marketplace.**

```typescript
{
  service: string    // Required: skill name
  skillsDir?: string // Skills directory
}
```

Published: SKILL.md, endpoints, auth method type, TypeScript template, creator wallet.
**NOT published:** Actual credentials.

---

### unbrowse_search

**Search and install skills from marketplace.**

```typescript
{
  query?: string   // Search term
  tags?: string    // Comma-separated filter tags
  install?: string // Skill ID to download
}
```

- **Search:** Free
- **Install:** $0.01 USDC via x402 payment

---

### unbrowse_wallet

**Manage Solana wallet for marketplace.**

```typescript
{
  action: "status" | "setup" | "set_creator" | "set_payer"
  wallet?: string     // Solana address (for set_creator)
  privateKey?: string // Base58 private key (for set_payer)
}
```

---

## Skill Generation Pipeline

### HAR Parsing (`src/har-parser.ts`)

**Filtering:**
- Removes static assets (CSS, JS, images, fonts)
- Removes third-party domains (analytics, ads, CDNs)
- Keeps XHR/Fetch requests only
- Keeps non-GET requests (always API calls)

**Domain detection:**
- Uses `seedUrl` parameter to identify correct service domain
- Derives service name: `www.api.example.com` → `example`

**Auth extraction:**
- Auth headers: `Authorization`, `X-API-Key`, `X-Auth-Token`
- Context headers: `OutletID`, `UserID`, `SupplierID`
- Cookies from `Set-Cookie` responses
- Detects auth method type (Bearer, Session, API Key)

**Output:**
```typescript
interface ApiData {
  service: string
  baseUrl: string
  authHeaders: Record<string, string>
  authMethod: string  // "Bearer Token", "Session", "API Key"
  cookies: Record<string, string>
  endpoints: Record<string, ParsedRequest[]>
}
```

### Skill Generator (`src/skill-generator.ts`)

**Generates three files:**

1. **SKILL.md**
```markdown
# Example API

**Auth:** Bearer Token
**Base URL:** https://api.example.com

## Endpoints
- `GET /api/users` — List users ✓
- `POST /api/users` — Create user
- `GET /api/users/:id` — Get user by ID
```

2. **auth.json**
```json
{
  "service": "example",
  "baseUrl": "https://api.example.com",
  "authMethod": "header",
  "headers": { "authorization": "Bearer eyJ..." },
  "cookies": { "session_id": "abc123" },
  "localStorage": { "access_token": "..." },
  "refreshConfig": { "url": "/oauth/token", ... }
}
```

3. **scripts/api.ts**
```typescript
export class ExampleClient {
  async get(endpoint: string, opts?: RequestOptions): Promise<unknown>
  async post(endpoint: string, opts?: RequestOptions): Promise<unknown>
  static async fromAuthFile(path: string): Promise<ExampleClient>
}
```

### Refresh Token Detection (`src/token-refresh.ts`)

**Detects:**
- Refresh endpoints: `/oauth/token`, `/auth/refresh`
- Bodies with `grant_type=refresh_token`
- OAuth authorization_code exchanges
- Response tokens: `access_token`, `refresh_token`, `expires_in`

**Stored in auth.json:**
```json
{
  "refreshConfig": {
    "url": "https://api.example.com/oauth/token",
    "method": "POST",
    "body": { "grant_type": "refresh_token", "refresh_token": "..." },
    "expiresInSeconds": 3600
  }
}
```

---

## Authentication Handling

### Auth Sources (Priority Order)

1. **auth.json** — Skill-specific credentials (fastest)
2. **Vault** — Encrypted local storage (AES-256-GCM)
3. **Chrome Cookies** — User's browser session
4. **Credential Provider** — Keychain, 1Password, Vault lookup

### Token Types Captured

| Type | Source | Usage |
|------|--------|-------|
| Bearer tokens | OAuth responses | `Authorization: Bearer <token>` |
| Session cookies | `Set-Cookie` headers | Cookie header |
| localStorage tokens | SPA auth state | Promoted to headers |
| sessionStorage tokens | Temporary SPA tokens | Promoted to headers |
| Meta tokens | `<meta>` CSRF tags | `X-CSRF-Token` header |

### Token Promotion

Tokens are automatically promoted to request headers:
```
localStorage.access_token → Authorization: Bearer <token>
localStorage.api_key → Authorization: <token>
sessionStorage.csrf_token → X-CSRF-Token: <token>
```

### Auto-Refresh Flow

1. Request returns 401 or 403
2. Check for `refreshConfig` in auth.json
3. If exists: POST to refresh endpoint with stored refresh_token
4. If `loginConfig` exists: re-login via browser
5. Update auth.json with new tokens
6. Retry original request

---

## Browser Connection Strategies

### Connection Cascade (`src/profile-capture.ts`)

Unbrowse tries multiple browser connection methods in order:

| Strategy | Port | Description |
|----------|------|-------------|
| Clawdbot browser | 18791 | Managed browser with persistent cookies |
| Chrome CDP | 9222/9229 | User's Chrome with `--remote-debugging-port` |
| Chrome profile | — | Launch with user-data directory |
| Playwright | — | Fresh headless Chromium (fallback) |

### Chrome Profile Launch

When Chrome isn't running:
1. Detect most recently used profile (by History file mtime)
2. Launch Chromium with `--profile-directory` flag
3. Load existing cookies and session state

**Note:** Chrome 127+ uses App-Bound Encryption—third-party apps can't read cookies. Use `unbrowse_login` to capture fresh credentials.

### Stealth Browser (`src/stealth-browser.ts`)

Cloud browser via BrowserBase for anti-bot protection:

```typescript
interface StealthSession {
  id: string           // Session ID
  cdpUrl: string       // Playwright connect URL
  liveUrl: string      // Human-viewable URL
  status: "active" | "stopped"
}
```

**Features:**
- Anti-detection (hides automation signals)
- Proxy rotation by country
- Full CDP support for Playwright
- Live viewing URL for debugging

**Cost:** ~$0.06/hour

---

## Marketplace & Payments

### Server Architecture (`server/`)

**Endpoints:**
| Route | Auth | Description |
|-------|------|-------------|
| `GET /skills/search` | Free | Full-text search |
| `GET /skills/:id/summary` | Free | Endpoint list |
| `GET /skills/:id/download` | x402 | Full skill package |
| `POST /skills/publish` | Free | Publish skill |
| `GET /health` | Free | Health check |

### x402 Payment Protocol

HTTP 402 Payment Required with Solana USDC:

**Flow:**
1. Client requests `/skills/:id/download`
2. Server returns 402 with payment requirements
3. Client signs Solana transaction
4. Client retries with `X-Payment` header
5. Server verifies payment on-chain
6. Server returns skill package

**Payment split:**
```
Skill creator:  30%
Platform:       65%
Gas fees:        5%
```

**Price:** $0.01 USDC per download

---

## Configuration

### Plugin Config (`clawdbot.json`)

```json
{
  "plugins": {
    "entries": {
      "unbrowse": {
        "config": {
          "skillsOutputDir": "~/.clawdbot/skills",
          "browserPort": 18791,
          "browserUseApiKey": "your-browserbase-key",
          "autoDiscover": true,
          "enableAgentContextHints": false,
          "skillIndexUrl": "https://skills.unbrowse.ai",
          "creatorWallet": "your-solana-address",
          "skillIndexSolanaPrivateKey": "base58-key",
          "credentialSource": "keychain"
        }
      }
    }
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `UNBROWSE_INDEX_URL` | Skill marketplace URL |
| `UNBROWSE_CREATOR_WALLET` | Solana address for earnings |
| `UNBROWSE_SOLANA_PRIVATE_KEY` | Base58 private key for payments |
| `UNBROWSE_CREDENTIAL_SOURCE` | "keychain", "1password", "vault" |

### Credential Sources

| Source | Description |
|--------|-------------|
| `keychain` | macOS Keychain (local, secure) |
| `1password` | 1Password CLI (`op` command) |
| `vault` | Unbrowse vault (SQLite + AES-256-GCM) |
| `none` | No credential management |

---

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Tool definitions, browser cascade, hooks |
| `src/har-parser.ts` | HAR → endpoints, auth extraction |
| `src/skill-generator.ts` | Generates SKILL.md, auth.json, api.ts |
| `src/vault.ts` | Encrypted credential storage |
| `src/token-refresh.ts` | OAuth/JWT refresh detection |
| `src/stealth-browser.ts` | BrowserBase cloud browser |
| `src/profile-capture.ts` | Playwright network capture |
| `src/session-login.ts` | Credential-based login |
| `src/skill-index.ts` | Marketplace client |
| `src/credential-providers.ts` | Keychain/1password/vault lookup |
| `src/dom-service.ts` | Browser element indexing |
| `src/site-crawler.ts` | Link crawling, OpenAPI detection |
