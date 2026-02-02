# Unbrowse

**100x faster web access for OpenClaw agents.**

## The Problem

AI agents like OpenClaw need to interact with websites. Today, they have two options:

1. **Official APIs** — Fast and reliable, but only ~1% of websites have them
2. **Browser automation** — Universal but painfully slow (5-60 seconds per action)

Browser automation means launching headless Chrome, waiting for pages to load, finding elements with fragile CSS selectors, clicking buttons, waiting for navigation, parsing DOM... all to get data that's already available as clean JSON in the network layer.

```
Browser Automation Reality
──────────────────────────
Launch browser         3-5s
Navigate to page       2-10s
Wait for load          1-5s
Find element           0.5-2s
Click/interact         0.5-1s
Wait for response      2-10s
Parse DOM              1-3s
──────────────────────────
Total: 10-40 seconds per action
Success rate: 70-85%
```

## The Solution

Every website has internal APIs — the XHR/fetch calls their frontend makes to load data. These endpoints are undocumented but return clean JSON, handle auth properly, and are 50-100x faster than browser automation.

**Unbrowse captures these internal APIs and turns them into skills your agent can call directly.**

```
Unbrowse
────────
Direct API call    →    JSON response
────────
Total: 200-500ms
Success rate: 95%+
```

## How It Works

### 1. You browse normally

Login to Twitter, scroll your feed, like a post. Unbrowse captures every API call the frontend makes:

- `GET /2/timeline/home.json` — fetches your feed
- `POST /2/timeline/like.json` — likes a tweet
- Auth headers, cookies, rate limits — all recorded

### 2. Unbrowse generates a skill

From captured traffic, Unbrowse creates a callable skill:

```typescript
// Generated automatically
twitter.getTimeline()     // 200ms, returns JSON
twitter.likeTweet(id)     // 150ms, returns status
twitter.postTweet(text)   // 180ms, returns tweet
```

### 3. Your agent uses it forever

No browser. No waiting. No fragile selectors. Just direct API calls at network speed.

```
┌─────────────────────────────────────────────────────────────┐
│                     BEFORE UNBROWSE                         │
│                                                             │
│  Agent → Launch browser → Load page → Find element →       │
│          Click → Wait → Parse DOM → Extract data           │
│                                                             │
│  Time: 30 seconds          Success: 75%                    │
├─────────────────────────────────────────────────────────────┤
│                     WITH UNBROWSE                           │
│                                                             │
│  Agent → API call → JSON response                          │
│                                                             │
│  Time: 300ms               Success: 95%+                   │
└─────────────────────────────────────────────────────────────┘
```

## What is OpenClaw?

[OpenClaw](https://openclaw.ai) is an open-source AI assistant that runs locally on your devices. It connects to your messaging apps (WhatsApp, Telegram, Slack, Discord, iMessage) and acts as a proactive digital assistant — managing emails, updating calendars, running commands, and taking autonomous actions across your online life.

Unlike cloud-based assistants, OpenClaw:
- Runs on your hardware (your data stays local)
- Has persistent memory across sessions
- Can execute shell commands and scripts
- Extends via community-built skills and plugins

**Unbrowse is an OpenClaw extension that gives your agent fast, reliable web access without browser automation overhead.**

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
"Browse twitter.com and capture the API"

# Or use the tool directly
unbrowse_capture url="twitter.com"
```

### Generate a skill

```bash
unbrowse_generate_skill domain="twitter.com"
```

### Use it

```bash
# Your agent can now call Twitter's internal API directly
unbrowse_replay skill="twitter" action="get_timeline"
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

## Skill Marketplace

Don't want to capture APIs yourself? Browse skills others have already created.

```bash
# Search for Twitter skills
unbrowse_search query="twitter"

# Install one (you own it forever)
unbrowse_install skill="twitter-timeline"
```

### Publish Your Own

Share captured APIs with other agents:

```bash
# Free
unbrowse_publish name="twitter-timeline"

# Paid ($2.50 USDC)
unbrowse_publish name="twitter-timeline" price="2.50"
```

**Earnings:** 70% to creator, 30% platform. Instant payout via x402 protocol on Solana.

**Ownership model:** Buyers own skills forever. One purchase, unlimited use. No per-execution fees.

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
| `credentialSource` | `none` | Password lookup: none/keychain/1password |

## Why Not Just Use Browser Automation?

| | Browser Automation | Unbrowse |
|---|---|---|
| **Speed** | 10-40 seconds | 200-500ms |
| **Reliability** | 70-85% (DOM changes break selectors) | 95%+ (APIs rarely change) |
| **Resource usage** | High (headless browser) | Minimal (HTTP calls) |
| **Auth handling** | Complex (cookies, sessions, CAPTCHAs) | Built-in (captured with traffic) |
| **Data format** | Parse from DOM | Clean JSON |

Browser automation has its place — when you need to interact with sites that truly require JavaScript rendering. But most "automation" is just fetching data that's already available via internal APIs.

## x402 Payments

Skill purchases use the [x402 protocol](https://x402.org) for machine-to-machine payments:

1. Agent requests skill download
2. Server returns HTTP 402 with payment requirements
3. Agent signs USDC transaction on Solana
4. Server verifies, returns skill

No intermediaries. Direct creator payment. Instant settlement.

---

**Skip the browser. Call the API.**

*Built for [OpenClaw](https://openclaw.ai). Powered by [x402](https://x402.org).*
