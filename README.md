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

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
```

Then capture any website:
```bash
# Browse a site and capture its internal APIs
unbrowse_capture url="polymarket.com"

# Use the generated skill directly
unbrowse_replay skill="polymarket" method="GET" path="/api/markets"
```

## The Problem

Your AI agent can only use websites that want to be used.

| Situation | What Happens |
|-----------|--------------|
| Official API exists | Works great |
| MCP server exists | Works great |
| Neither exists (99% of sites) | Browser automation. Pain. |

MCPs are great — when they exist. But someone has to build each one manually. There are millions of websites. There are dozens of MCPs.

**Your agent is waiting for permission that's never coming.**

## What Happens Without Unbrowse

You ask your agent to check Polymarket odds.

```
Agent launches Chrome          5s
Loads the page                 3s
Waits for JavaScript           2s
Finds the element              1s
Reads the text                 1s
────────────────────────────────
Total                         12s
```

Meanwhile, when that page loaded, it called `GET /api/markets/election` — a 200ms request that returned all the data as clean JSON.

Your agent just didn't know about it.

## What Happens With Unbrowse

```
Agent calls internal API     200ms
Gets JSON response          done
```

**100x faster.** Your agent is finally faster than you.

## How It Works (Technically)

Unbrowse operates in three stages:

### 1. Capture (HAR recording)
When you browse a site with Unbrowse active, it intercepts all network traffic using Chrome DevTools Protocol (CDP). We capture:
- XHR/Fetch requests and responses
- WebSocket traffic
- Authentication headers, cookies, tokens
- Request/response body and headers

This produces a HAR (HTTP Archive) or live traffic stream.

### 2. Extraction (HAR → API endpoints)
The HAR parser analyzes captured traffic to:
- Identify actual API endpoints (JSON/XML responses, not static assets)
- Cluster similar requests and infer parameters
- Detect authentication method (Bearer token, cookie session, API key)
- Extract the base URL and service name
- Clean sensitive data (tokens are stored separately in the vault)

### 3. Generation (Endpoints → Skill)
From the extracted data, we generate:
- `SKILL.md` — Human-readable API documentation
- `scripts/api.ts` — TypeScript client with typed methods
- `auth.json` — Auth configuration (encrypted in vault)
- `references/REFERENCE.md` — Detailed endpoint reference

The skill is now usable by your agent via direct HTTP calls.

```
Browser Traffic → HAR Capture → API Extraction → Skill Generation → Agent Usage
        │                │               │                  │              │
        └─ CDP hook ─────┘    └─ Pattern ───┘    ├─ SKILL.md     └─ unbrowse_replay
                                                    ├─ api.ts
                                                    └─ auth.json
```

## Tools

### Capture & Generate

| Tool | Description |
|------|-------------|
| `unbrowse_capture` | Capture API traffic from URLs |
| `unbrowse_learn` | Parse HAR file into skill |
| `unbrowse_login` | Login and capture session |
| `unbrowse_replay` | Execute API calls using skills |

### Auth & Sessions

| Tool | Description |
|------|-------------|
| `unbrowse_auth` | Extract auth from browser session |
| `unbrowse_skills` | List captured skills |
| `unbrowse_wallet` | Manage Solana wallet for marketplace |

### Marketplace

| Tool | Description |
|------|-------------|
| `unbrowse_search` | Find skills others have created |
| `unbrowse_download` | Install a skill (free or paid via x402) |
| `unbrowse_publish` | Share your skills (free or paid) |
| `unbrowse_record` | Record multi-step workflows |

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

## Marketplace: Google for Agents

Humans have Google. Agents have nothing.

No way to search "how do I use Polymarket?" No index of capabilities. Just trial and error on every site.

**Unbrowse Marketplace is Google for agents.**

```bash
# Search for existing skills
unbrowse_search query="polymarket"

# Install (you own it forever)
unbrowse_download skill_id="polymarket-trading"
```

No figuring it out. No browser. Just API calls.

### x402: Agents Pay for Themselves

Some skills are free. Some are paid.

Paid skills use [x402](https://x402.org) — machine-to-machine payments on Solana:

1. Agent requests skill
2. Gets HTTP 402 with price
3. Signs USDC transaction
4. Receives skill

No human approval needed. Agents buying their own capabilities.

### Publish Your Skills

Captured an API? Publish it.

```bash
# Free
unbrowse_publish service="polymarket-odds"

# Paid ($2.50 USDC)
unbrowse_publish service="polymarket-trading" price_usdc=2.50
```

**Creator gets 70%. Instant payout in USDC.**

## Configuration

```json
{
  "plugins": {
    "entries": {
      "unbrowse-openclaw": {
        "enabled": true,
        "config": {
          "skillsOutputDir": "~/.openclaw/skills",
          "autoDiscover": true,
          "creatorWallet": "YOUR_SOLANA_ADDRESS"
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `skillsOutputDir` | `~/.openclaw/skills` | Where skills are saved |
| `autoDiscover` | `true` | Auto-generate skills while browsing |
| `creatorWallet` | - | Solana address for marketplace earnings |

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
