# Unbrowse

[![npm version](https://img.shields.io/npm/v/@getfoundry/unbrowse-openclaw.svg)](https://www.npmjs.com/package/@getfoundry/unbrowse-openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/lekt9/unbrowse-openclaw.svg)](https://github.com/lekt9/unbrowse-openclaw)

> Turn any website's internal APIs into agent-callable skills

```
Before:  Browser automation → 45 seconds → 75% success
After:   Direct API calls    → 200ms    → 95%+ success
```

<!-- Demo placeholder - add GIF/video here -->
<!-- ![Demo](docs/demo.gif) -->

## Quick Start

### 1. Install

Just tell your agent:

> "Install the unbrowse plugin"

Or manually:
```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
```

### 2. Learn a site

> "Learn airbnb.com"

Unbrowse opens the site, captures all internal API traffic, and generates a reusable skill. That's it — your agent now knows Airbnb's internal API.

### 3. Use it

> "Search Airbnb for cabins in Colorado"

Your agent calls Airbnb's internal search API directly. No browser. 200ms.

### 4. Login for authenticated sites

> "Log into twitter.com"

Unbrowse captures your session cookies and tokens. Now your agent can act as you — post, like, DM — using Twitter's internal API.

### 5. Find skills others have shared

> "Search the marketplace for a Reddit skill"

> "Download the reddit-api skill"

No need to reverse-engineer everything yourself. If someone already captured it, just download it.

### 6. Publish your own

> "Publish the airbnb skill for 1 USDC"

Share your captured skills. Free or paid — creators get 70% of paid downloads in USDC.

---

## The Problem

Your AI agent can only use websites that want to be used.

| Situation | What Happens |
|-----------|--------------|
| Official API exists | Works great |
| MCP server exists | Works great |
| Neither exists (99% of sites) | Browser automation. Pain. |

MCPs are great — when they exist. But someone has to build each one manually. There are millions of websites. There are dozens of MCPs.

**Your agent is waiting for permission that's never coming.**

## How It Works

Every website has internal APIs — the XHR/fetch calls their frontend makes to load data, submit forms, and perform actions. Unbrowse captures this traffic and turns it into callable endpoints.

```
You browse a site normally
        ↓
Unbrowse captures all API traffic (CDP)
        ↓
Filters out noise (analytics, ads, CDNs)
        ↓
Extracts endpoints, auth, and parameters
        ↓
Generates a skill your agent can use
        ↓
Agent calls APIs directly — no browser needed
```

### What it captures

- XHR/Fetch requests and responses
- Authentication headers, cookies, tokens
- Request/response bodies
- Custom auth headers (Bearer, API keys, session tokens, CSRF)

### What it generates

```
skill-name/
├── SKILL.md          # API documentation
├── auth.json         # Session cookies, tokens, API keys
├── scripts/
│   └── api.ts        # Generated TypeScript client
└── references/
    └── REFERENCE.md  # Detailed endpoint reference
```

## Usage Examples

These are things you say to your agent. Unbrowse handles the rest.

### Capture & Replay

| You say | What happens |
|---------|--------------|
| "Learn polymarket.com" | Captures internal API traffic, generates skill |
| "Replay polymarket GET /api/markets" | Calls the API directly, returns JSON |
| "Log into notion.com" | Authenticates and captures session tokens |
| "Learn this HAR file" | Parses an exported HAR into a skill |

### Marketplace

| You say | What happens |
|---------|--------------|
| "Search for a Spotify skill" | Searches the skill marketplace |
| "Download the spotify-api skill" | Installs it (free or paid via x402) |
| "Publish the airbnb skill for 2 USDC" | Lists it on the marketplace |
| "Publish the weather skill for free" | Lists it for free |

### Skills & Auth

| You say | What happens |
|---------|--------------|
| "List my skills" | Shows all captured/downloaded skills |
| "Extract auth for twitter.com" | Pulls cookies and tokens from your browser session |
| "Set up my wallet" | Creates a Solana wallet for marketplace payments |

## Why Not Browser Automation?

| | Browser | Unbrowse |
|---|---|---|
| **Speed** | 10-45 seconds | 200ms |
| **Reliability** | 70-85% | 95%+ |
| **Resources** | Headless Chrome | HTTP calls |
| **Auth** | Complex | Built-in |
| **Data** | Parse DOM | Clean JSON |

The browser is a 45-second tax on every web action. Skip it.

## Why Not Wait for APIs/MCPs?

| | Official APIs | MCPs | Unbrowse |
|---|---|---|---|
| **Coverage** | ~1% of sites | ~0.01% of sites | Any site |
| **Wait time** | Never coming | Years | Minutes |
| **Your control** | None | None | Full |

99% of websites will never have an API. Your agent needs to work anyway.

## Marketplace

Humans have Google. Agents have nothing. No way to search "how do I use Polymarket?" No index of capabilities.

**Unbrowse Marketplace is Google for agents.**

### x402: Agents Pay for Themselves

Paid skills use [x402](https://x402.org) — machine-to-machine payments on Solana:

1. Agent requests skill
2. Gets HTTP 402 with price
3. Signs USDC transaction
4. Receives skill

No human approval needed. Agents buying their own capabilities. Creators get 70%, instant payout in USDC.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup
- Running tests
- Code style guide
- Submitting PRs

## License

MIT — see [LICENSE](LICENSE)

---

**Every website now has an API. Your agent just didn't know about it.**

[unbrowse.ai](https://unbrowse.ai) · [x402 Protocol](https://x402.org)
