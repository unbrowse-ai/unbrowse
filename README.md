# Unbrowse

**Browse once. Automate forever.**

The action layer for AI agents. Capture what happens when you browse, replay it 50x faster without a browser.

```
You browse a website
        ↓
Unbrowse captures all API calls
        ↓
Agents replay them directly—no screenshots, no clicking
        ↓
0.3 seconds. 95% reliable. Works on any site.
```

---

## The Problem

AI agents still interact with websites like it's 1999:

1. Take screenshot
2. Parse with vision model  
3. Click button
4. Wait for page load
5. Repeat

**30-45 seconds per action. 70% success rate. Breaks when the UI changes.**

This is insane. When you click "Buy Now," your browser sends a simple HTTP request. The button is just decoration.

## The Solution

Unbrowse captures those HTTP requests and replays them directly:

- **No screenshots** — direct network communication
- **No waiting** — sub-second execution
- **No breaking** — APIs are more stable than UIs
- **No limits** — works on sites without public APIs

| | Browser Automation | Unbrowse |
|---|---|---|
| Speed | 30-45s/action | 0.3s/action |
| Reliability | ~70% | ~95% |
| Cost | $0.01-0.05/action | $0.0001/action |
| Coverage | Sites with APIs | Any website |

---

## Quick Start

```bash
# Install
cd extensions/unbrowse && bun install

# Capture a site (crawls, discovers APIs, generates skill)
bunx unbrowse capture https://eatigo.com

# Or interact manually (browser-use style)
bunx unbrowse interact https://eatigo.com/book

# Replay without browser
bunx unbrowse replay eatigo search '{"cuisine": "japanese"}'
```

---

## How It Works

### 1. Capture

Point Unbrowse at any URL. It launches a browser, watches all network traffic, and learns how the site works.

```bash
unbrowse_capture --url "https://booking.com"
```

What it captures:
- Every XHR/fetch request as full HAR entries
- Auth patterns (cookies, headers, tokens)
- Session state (localStorage, sessionStorage)
- Endpoint schemas and parameters

### 2. Generate

Unbrowse turns captured traffic into a **skill**—a reusable package any agent can use.

```
booking.com/
├── SKILL.md      # Human-readable API docs
├── auth.json     # Session state (local only)
└── scripts/
    └── api.ts    # TypeScript client
```

### 3. Replay

Execute API calls without a browser. Auth is handled automatically.

```bash
unbrowse_replay --skill "booking" --action "search" \
  --params '{"city": "tokyo", "dates": "2025-03-01"}'
```

If auth expires, Unbrowse re-runs login and retries. Session state persists across calls.

### 4. Share

Publish skills to the marketplace. Others download and use them. You earn.

```bash
unbrowse_publish --skill "booking"  # Credentials stripped automatically
```

Skills go through security review before becoming available.

---

## Browser Interaction

`unbrowse_interact` drives pages autonomously—click, fill, select by element index:

```
[1] <button> Book Now
[2] <input type="text" placeholder="Search">
[3] <select name="guests"> options=[1, 2, 3, 4, 5+]
```

| Action | Example | Description |
|--------|---------|-------------|
| `click_element` | `index=1` | Click by index |
| `input_text` | `index=2, text="Tokyo"` | Type into input |
| `select_option` | `index=3, text="2"` | Select dropdown |
| `extract_content` | — | Read full page |
| `done` | `text="Booked"` | Signal completion |

All network traffic during interaction is captured automatically.

---

## Tools

| Tool | Purpose |
|------|---------|
| `unbrowse_capture` | Visit URLs, crawl, capture traffic, generate skill |
| `unbrowse_replay` | Execute API calls with captured auth |
| `unbrowse_interact` | Browser-use style page interaction |
| `unbrowse_login` | Login with credentials, capture full session |
| `unbrowse_learn` | Parse HAR files into skills |
| `unbrowse_skills` | List local skills |
| `unbrowse_publish` | Push to marketplace |
| `unbrowse_search` | Find and install community skills |

---

## Session Persistence

Auth state lives in `auth.json` and persists across tool calls:

```json
{
  "service": "eatigo",
  "authMethod": "Cookie + Bearer",
  "headers": { "Authorization": "Bearer eyJ..." },
  "cookies": { "session_id": "xyz" },
  "localStorage": { "access_token": "..." }
}
```

After every replay:
- `Set-Cookie` headers accumulated
- Session headers (csrf, auth) captured  
- localStorage/sessionStorage re-extracted
- Written back to `auth.json`

Multi-step flows work across separate tool calls with no session loss.

---

## Skill Marketplace

### Download skills others have created

```bash
unbrowse_search --query "restaurant booking singapore"
unbrowse_search --query "stock prices"
```

### Publish your own

```bash
unbrowse_publish --skill "mysite"
```

Skills go through two-layer security review:
1. **Static scan** — 25+ patterns for shell exec, key access, eval, exfil
2. **LLM review** — Claude/GPT analyzes for supply chain attacks

Only approved skills appear in search and are downloadable.

---

## Payments (x402)

Unbrowse implements HTTP 402 Payment Required using Solana USDC micropayments.

### Pricing Model: Skill Ownership

Skills are purchased once and owned forever:

```
Agent discovers skill → pays $0.01 → downloads full package → unlimited replays
```

**Why ownership, not per-execution?**
- **Offline-first**: Skills work without network after download
- **Predictable costs**: Pay once, use forever—no metering surprises
- **Fast execution**: No payment verification on every API call
- **Privacy**: Usage patterns stay local

### 4-Party Revenue Split

| Recipient | Share | Description |
|-----------|-------|-------------|
| Website Owner | 65% | Original API owner (via DNS verification) |
| Platform | 30% | Unbrowse infrastructure |
| Skill Creator | 3% | Agent/human who indexed the site |
| Fee Payer | 2% + gas | Transaction processing |

Unclaimed shares (e.g., unverified website owners) go to platform treasury.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Request                            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Skill Marketplace Server                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ GET /skills │→ │ x402 Gate   │→ │ Verify Solana Payment   │  │
│  │ /:id/download│  │ (402 resp)  │  │ via x402 Smart Contract │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
              Payment verified? │
                    ┌───────────┴───────────┐
                    │                       │
                   Yes                      No
                    │                       │
                    ▼                       ▼
          Return skill package      Return 402 with
          (SKILL.md + api.ts)       payment instructions
```

### Payment Flow

1. Agent requests `GET /skills/:id/download`
2. Server returns `402 Payment Required` with x402 schema
3. Agent constructs Solana transaction with 4-party split
4. Agent submits signed transaction in `X-Payment` header
5. Server verifies transaction via simulation + on-chain confirmation
6. Server returns skill package, records download + earnings

### Configuration

| Env Var | Description |
|---------|-------------|
| `FDRY_TREASURY_WALLET` | Platform treasury (required for paid mode) |
| `SOLANA_RPC_URL` | RPC endpoint (devnet or mainnet) |
| `USDC_MINT` | USDC token mint address |
| `DOWNLOAD_PRICE_CENTS` | Price per download (default: 1.0) |

Skills are free when `FDRY_TREASURY_WALLET` is not set (dev mode).

---

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `skillsOutputDir` | `~/.moltbot/skills` | Local skill storage |
| `autoDiscover` | `true` | Auto-generate skills while browsing |
| `browserPort` | `18791` | CDP browser control port |
| `credentialSource` | `none` | Password lookup: `keychain`, `1password`, `vault` |

---

## Security

- **Credentials stay local** — `auth.json` never leaves your machine
- **Auto-sanitization** — Publishing strips all credentials
- **Two-layer review** — Static + LLM analysis before approval
- **Pending until reviewed** — Only approved skills are discoverable

---

## The Vision

**Google indexed information. Unbrowse indexes actions.**

When agents need to act on the web—buy, book, post, extract—they query Unbrowse's skill index instead of fumbling through UIs.

2 billion websites. 5,000 public APIs. Unbrowse makes the other 1,999,995,000 accessible to AI.

---

## Links

- [Documentation](https://docs.unbrowse.ai)
- [Skill Marketplace](https://skills.unbrowse.ai)
- [GitHub](https://github.com/getfoundry/unbrowse)

---

## License

MIT
```