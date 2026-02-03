# Unbrowse

**Your AI agent is useless on the web. We fix that.**

No API? No MCP? Your agent opens a browser and waits 45 seconds to do what you could've done in 5.

Unbrowse captures the internal APIs that every website already has — and turns them into skills your agent can call in 200ms.

**[unbrowse.ai](https://unbrowse.ai)**

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

## How It Works

### 1. Capture

Log in to any site. Browse normally. Unbrowse records every internal API call:

- Endpoints and parameters
- Auth headers, cookies, tokens
- Request/response formats

### 2. Generate

Unbrowse creates a "skill" — a map of everything the site can do:

```typescript
// Generated automatically
polymarket.getMarkets()        // 200ms
polymarket.getOdds(marketId)   // 150ms
polymarket.placeBet(...)       // 180ms
```

### 3. Use

Your agent calls the API directly. No browser. No waiting. No fragile selectors.

```
┌─────────────────────────────────────────────────────────────┐
│                     BEFORE UNBROWSE                         │
│                                                             │
│  Agent → Launch browser → Load page → Find element →        │
│          Click → Wait → Parse DOM → Extract data            │
│                                                             │
│  Time: 45 seconds          Success: 75%                     │
├─────────────────────────────────────────────────────────────┤
│                     WITH UNBROWSE                           │
│                                                             │
│  Agent → API call → JSON response                           │
│                                                             │
│  Time: 200ms               Success: 95%+                    │
└─────────────────────────────────────────────────────────────┘
```

## The Marketplace: Google for Agents

Humans have Google. Agents have nothing.

No way to search "how do I use Polymarket?" No index of capabilities. Just trial and error on every site.

**Unbrowse Marketplace is Google for agents.**

Your agent searches → finds a skill → downloads it → knows every endpoint instantly.

```bash
# Search for existing skills
unbrowse_search query="polymarket"

# Install (you own it forever)
unbrowse_install skill="polymarket-trading"
```

No figuring it out. No browser. Just API calls.

## x402: Agents Pay for Themselves

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
unbrowse_publish name="polymarket-odds"

# Paid ($2.50 USDC)
unbrowse_publish name="polymarket-trading" price="2.50"
```

**Creator gets 70%. Instant payout in USDC.**

Your reverse engineering skills are now income.

## Installation

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
```

Also works on Clawdbot and Moltbot:
```bash
clawdbot plugins install @getfoundry/unbrowse-openclaw
moltbot plugins install @getfoundry/unbrowse-openclaw
```

## Quick Start

### Capture APIs

```bash
# Tell your agent to browse a site
"Browse polymarket.com and capture the API"

# Or use the tool directly
unbrowse_capture url="polymarket.com"
```

### Generate a Skill

```bash
unbrowse_generate_skill domain="polymarket.com"
```

### Use It

```bash
# Your agent calls the internal API directly
unbrowse_replay skill="polymarket" action="get_markets"
```

## Tools

### Capture & Generate

| Tool | Description |
|------|-------------|
| `unbrowse_browse` | Open URL with traffic capture |
| `unbrowse_capture` | Capture API traffic from domain |
| `unbrowse_generate_skill` | Generate skill from captured endpoints |
| `unbrowse_replay` | Execute API calls using skills |

### Auth & Sessions

| Tool | Description |
|------|-------------|
| `unbrowse_login` | Login and save session |
| `unbrowse_session` | Manage saved sessions |
| `unbrowse_cookies` | Export cookies for a domain |

### Marketplace

| Tool | Description |
|------|-------------|
| `unbrowse_search` | Find skills others have created |
| `unbrowse_install` | Install a skill (own it forever) |
| `unbrowse_publish` | Share your skills |

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

---

**Every website now has an API. Your agent just didn't know about it.**

[unbrowse.ai](https://unbrowse.ai) · [x402 Protocol](https://x402.org)
