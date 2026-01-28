# Unbrowse

**Browse once. Automate forever.**

Unbrowse is a self-learning browser agent that captures API traffic from websites and turns it into reusable skills. When APIs need to be called again, it replays them directly—no screenshots, no clicking, no waiting.

```
You browse a website
        ↓
Unbrowse captures all API calls
        ↓
Agents replay them directly
        ↓
0.3 seconds. 95% reliable. Works on any site.
```

## Why Unbrowse?

Traditional browser automation:
1. Take screenshot → 2. Send to vision model → 3. Parse response → 4. Click element → 5. Wait → 6. Repeat

**Result:** 30+ seconds per action, 60% reliability, breaks when UI changes.

Unbrowse:
1. Capture APIs once → 2. Replay directly forever

**Result:** 0.3 seconds per action, 95% reliability, survives UI redesigns.

## Quick Start

```bash
# Install
npm install
npx playwright install chromium

# Capture APIs from any website
unbrowse_capture urls=["https://api.example.com"]

# Replay without a browser
unbrowse_replay service="example" endpoint="GET /api/users"
```

See the [Quickstart Guide](./docs/QUICKSTART.md) for more examples.

## Features

### Automatic Skill Generation
- Captures XHR/Fetch traffic from any website
- Extracts endpoints, auth headers, cookies, tokens
- Generates SKILL.md documentation + TypeScript client
- Detects OAuth/JWT refresh patterns for auto-renewal

### Smart Authentication
- Captures session cookies, Bearer tokens, API keys
- Stores credentials in encrypted vault (AES-256-GCM)
- Auto-refreshes expired tokens
- Integrates with macOS Keychain and 1Password

### Browser Connection Cascade
- Connects to existing Chrome sessions (CDP)
- Uses Chrome profile with saved logins
- Falls back to Playwright for fresh sessions
- Stealth cloud browser for anti-bot protection

### Skill Marketplace
- Publish skills for others to use
- Search and install community skills
- Earn USDC when your skills are downloaded
- x402 micropayments on Solana

## Tools

| Tool | Description |
|------|-------------|
| `unbrowse_capture` | Visit URLs, capture traffic, generate skill |
| `unbrowse_replay` | Execute APIs using stored credentials |
| `unbrowse_login` | Log in with credentials, capture session |
| `unbrowse_interact` | Drive browser with indexed element targeting |
| `unbrowse_stealth` | Cloud browser with anti-bot detection |
| `unbrowse_skills` | List local skills |
| `unbrowse_search` | Search marketplace |
| `unbrowse_publish` | Publish skill to marketplace |

## Documentation

- [**Quickstart Guide**](./docs/QUICKSTART.md) — Get started in 5 minutes
- [**Architecture**](./docs/ARCHITECTURE.md) — How it all works
- [**Contributing**](./CONTRIBUTING.md) — Development setup

## How Skills Work

A "skill" is a captured API integration:

```
~/.clawdbot/skills/twitter/
├── SKILL.md           # Endpoint documentation
├── auth.json          # Credentials (encrypted in vault)
└── scripts/
    └── api.ts         # Generated TypeScript client
```

**SKILL.md:**
```markdown
# Twitter API

**Auth:** Bearer Token
**Base URL:** https://api.twitter.com

## Endpoints
- `GET /2/users/me` — Get authenticated user ✓
- `GET /2/tweets/:id` — Get tweet by ID ✓
- `POST /2/tweets` — Create tweet
```

**Usage:**
```typescript
// Direct API call
unbrowse_replay service="twitter" endpoint="GET /2/users/me"

// With body
unbrowse_replay service="twitter" endpoint="POST /2/tweets" body='{"text":"Hello!"}'
```

## Configuration

```json
{
  "plugins": {
    "entries": {
      "unbrowse": {
        "config": {
          "skillsOutputDir": "~/.clawdbot/skills",
          "browserUseApiKey": "your-browserbase-key",
          "credentialSource": "keychain",
          "creatorWallet": "your-solana-address"
        }
      }
    }
  }
}
```

| Option | Description |
|--------|-------------|
| `skillsOutputDir` | Where skills are saved |
| `browserUseApiKey` | BrowserBase API key for stealth browser |
| `credentialSource` | `"keychain"`, `"1password"`, `"vault"`, or `"none"` |
| `creatorWallet` | Solana address to receive marketplace earnings |
| `autoDiscover` | Auto-generate skills from browser activity |

## Marketplace

Share and monetize your API skills:

```bash
# Publish a skill
unbrowse_publish service="my-api"

# Search for skills
unbrowse_search query="twitter"

# Install a skill ($0.01 USDC)
unbrowse_search install="skill-id"
```

Set up your wallet:
```bash
unbrowse_wallet action="setup"
```

## Requirements

- Node.js 18+ or Bun
- Playwright (`npx playwright install chromium`)
- macOS (for Keychain integration) or any OS (for vault storage)

## License

MIT

## Links

- [Clawdbot](https://github.com/lekt9/clawdbot) — The AI agent framework
- [BrowserBase](https://browserbase.com) — Cloud browser provider
