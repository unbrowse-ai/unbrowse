# Unbrowse

**100x faster web access for AI agents.**

Skip browser automation. Unbrowse captures the internal APIs that power any website and lets your agent call them directly. What takes Playwright 30 seconds takes Unbrowse 300ms.

```
Browser Automation          Unbrowse
─────────────────          ─────────
Launch browser             Direct API call
Wait for page load         ↓
Find element               Response
Click
Wait for navigation
Parse DOM
Extract data

~30 seconds                ~300ms
```

## Why Unbrowse?

Every website has internal APIs — the XHR/fetch calls their frontend makes. These are undocumented, fast, and return clean JSON. Unbrowse captures them once, then your agent calls them forever.

| Approach | Speed | Reliability | Auth |
|----------|-------|-------------|------|
| Browser automation | Slow (30s+) | Fragile (DOM changes) | Complex |
| Unbrowse | Fast (300ms) | Stable (APIs rarely change) | Built-in |

**No more:**
- Waiting for pages to load
- Fragile CSS selectors
- Headless browser overhead
- CAPTCHA battles
- Rate limit detection

## Installation

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
```

## Quick Start

### 1. Capture APIs from any site

```bash
# Browse normally — Unbrowse captures all API traffic
"Browse twitter.com and capture the API"
```

Unbrowse intercepts:
- Endpoint URLs and methods
- Request/response payloads
- Auth headers and cookies
- Rate limit patterns

### 2. Generate a skill

```bash
unbrowse_generate_skill domain="twitter.com"
```

Creates a callable skill with:
- All discovered endpoints
- Auth handling (Bearer, cookies, sessions)
- TypeScript wrapper code

### 3. Use it — 100x faster

```bash
# Instead of browser automation:
unbrowse_replay skill="twitter" action="get_timeline"
# Returns JSON in ~300ms
```

Your agent now has direct API access. No browser. No waiting. No fragility.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  YOU                    UNBROWSE                 AGENT   │
│                                                          │
│  Browse site  ──►  Capture traffic  ──►  Direct API     │
│  Login once        Extract auth          calls forever  │
│  Use normally       Generate skill        100x faster    │
└──────────────────────────────────────────────────────────┘
```

1. **Capture** — Browse any site. Unbrowse records all API calls.
2. **Extract** — Auth tokens, cookies, headers automatically saved.
3. **Generate** — AI creates a typed skill from captured traffic.
4. **Replay** — Agent calls APIs directly. No browser needed.

## Tools

### Core

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
| `unbrowse_install` | Install a skill |
| `unbrowse_publish` | Share your skills (free or paid) |

## Skill Marketplace

Share captured APIs with other agents. Earn USDC when they download.

```bash
# Publish free
unbrowse_publish name="twitter-timeline"

# Publish paid ($2.50)
unbrowse_publish name="twitter-timeline" price="2.50"
```

**Earnings:** 70% to creator, 30% platform. Instant payout via x402 on Solana.

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
          "creatorWallet": "YOUR_SOLANA_ADDRESS",
          "credentialSource": "none"
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
| `creatorWallet` | - | Solana address for earnings |
| `credentialSource` | `none` | Password lookup: none/keychain/1password |

## Platform Support

Works on all OpenClaw-compatible platforms:

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
clawdbot plugins install @getfoundry/unbrowse-openclaw
moltbot plugins install @getfoundry/unbrowse-openclaw
```

---

**100x faster. Zero browser overhead. Direct API access.**

*Built for OpenClaw. Powered by x402.*
