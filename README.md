# Unbrowse

**Reverse engineer any API. Turn it into a monetizable skill for AI agents.**

Unbrowse is an [OpenClaw](https://github.com/lekt9/openclaw) / [Clawdbot](https://github.com/lekt9/clawdbot) extension that captures API traffic from any website, auto-generates reusable skills, and lets you publish them to a marketplace where you earn USDC on every download.

```
┌─────────────────────────────────────────────────────────────┐
│                        UNBROWSE                             │
│                                                             │
│   Capture ──► Generate ──► Publish ──► Earn                │
│       │          │           │          │                   │
│       ▼          ▼           ▼          ▼                   │
│   API traffic  skills    marketplace   USDC                │
│   auth headers schemas   x402 payments 33% revenue         │
│   payloads     docs      Solana        per download        │
└─────────────────────────────────────────────────────────────┘
```

## Installation

### One-liner (Recommended)

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
```

That's it. Downloads, extracts, enables, and loads automatically.

---

### Alternative: Manual Config

Add to `~/.openclaw/openclaw.json` (or `~/.clawdbot/clawdbot.json`):

```json
{
  "plugins": {
    "entries": {
      "unbrowse": { "enabled": true }
    }
  }
}
```

Then restart:
```bash
openclaw gateway restart
```

### Option C: GitHub Source

```json
{
  "plugins": {
    "entries": {
      "unbrowse": {
        "enabled": true,
        "source": "github:lekt9/unbrowse"
      }
    }
  }
}
```

### Option D: Manual Clone

```bash
git clone https://github.com/lekt9/unbrowse ~/.openclaw/extensions/unbrowse
cd ~/.openclaw/extensions/unbrowse && npm install
openclaw gateway restart
```

## How It Works

### 1. Capture

Browse any website normally. Unbrowse intercepts all API traffic:
- Endpoint URLs and methods
- Request/response payloads
- Authentication headers
- Cookies and tokens

```bash
# Using the agent
"Browse twitter.com and capture the API"

# Or directly
unbrowse_capture url="twitter.com"
```

### 2. Generate

AI analyzes captured traffic and generates production-ready skills:
- OpenAPI-style schemas
- Auth handling (Bearer, cookies, etc.)
- Documentation and examples
- TypeScript wrapper code

```bash
# Auto-generated from captured traffic
unbrowse_generate_skill domain="twitter.com"
```

### 3. Publish

Push skills to the marketplace with optional pricing:

```bash
# Free skill (default)
unbrowse_publish name="twitter-timeline"

# Paid skill ($2.50 USDC)
unbrowse_publish name="twitter-timeline" price="2.50"
```

### 4. Earn

When other agents download your skill:
- **33%** goes to you (the creator)
- **33%** goes to the platform
- **34%** goes to network development

Payments are instant via x402 protocol on Solana (USDC).

## Tools

### Capture & Browse

| Tool | Description |
|------|-------------|
| `unbrowse_browse` | Open URL in browser with traffic capture |
| `unbrowse_capture` | Capture API traffic from a domain |
| `unbrowse_profile` | Record a browsing session with login |
| `unbrowse_act` | Execute browser actions (click, type, scroll) |

### Skill Generation

| Tool | Description |
|------|-------------|
| `unbrowse_generate_skill` | Generate skill from captured endpoints |
| `unbrowse_install` | Install a skill from the marketplace |
| `unbrowse_replay` | Execute API calls using installed skills |

### Marketplace

| Tool | Description |
|------|-------------|
| `unbrowse_search` | Search the skill marketplace |
| `unbrowse_publish` | Publish a skill (free or paid) |
| `unbrowse_wallet` | Manage your Solana wallet for payments |

### Session Management

| Tool | Description |
|------|-------------|
| `unbrowse_login` | Login to a service and save session |
| `unbrowse_session` | List/manage saved sessions |
| `unbrowse_cookies` | Export cookies for a domain |

## Configuration

Full config example:

```json
{
  "plugins": {
    "entries": {
      "unbrowse": {
        "enabled": true,
        "config": {
          "skillsOutputDir": "~/.openclaw/skills",
          "autoDiscover": true,
          "skillIndexUrl": "https://index.unbrowse.ai",
          "marketplace": {
            "creatorWallet": "YOUR_SOLANA_WALLET_ADDRESS",
            "solanaPrivateKey": "YOUR_BASE58_PRIVATE_KEY",
            "defaultPrice": "0"
          },
          "browser": {
            "useApiKey": "bu_...",
            "proxyCountry": "us"
          },
          "credentialSource": "none"
        }
      }
    }
  }
}
```

### Config Options

| Option | Default | Description |
|--------|---------|-------------|
| `skillsOutputDir` | `~/.openclaw/skills` | Where generated skills are saved |
| `autoDiscover` | `true` | Auto-generate skills when browsing APIs |
| `skillIndexUrl` | `https://index.unbrowse.ai` | Marketplace API URL |
| `marketplace.creatorWallet` | - | Solana address to receive USDC |
| `marketplace.solanaPrivateKey` | - | Private key for x402 payments |
| `marketplace.defaultPrice` | `"0"` | Default price for new skills |
| `browser.useApiKey` | - | Browser Use API key for stealth |
| `browser.proxyCountry` | `"us"` | Proxy location for stealth browser |
| `credentialSource` | `"none"` | Password lookup: none/keychain/1password |

## x402 Payment Protocol

Unbrowse uses the x402 protocol for machine-to-machine payments:

```
1. Agent requests skill download
2. Server returns HTTP 402 with payment requirements
3. Agent signs USDC transaction on Solana
4. Agent retries with signed transaction in X-Payment header
5. Server verifies on-chain, returns skill content
```

No intermediaries. Direct creator payment. Instant settlement.

### Pricing

| Type | Price | Description |
|------|-------|-------------|
| Free | $0.00 | Default — maximum adoption |
| Paid | $0.10 - $100 | Creator sets price, earns 33% |

## Platform Support

Unbrowse works on all OpenClaw-compatible platforms:

| Platform | Config File | Install Command |
|----------|-------------|-----------------|
| OpenClaw | `~/.openclaw/openclaw.json` | `openclaw plugins install @getfoundry/unbrowse-openclaw` |
| Clawdbot | `~/.clawdbot/clawdbot.json` | `clawdbot plugins install @getfoundry/unbrowse-openclaw` |
| Moltbot | `~/.moltbot/moltbot.json` | `moltbot plugins install @getfoundry/unbrowse-openclaw` |

## Cloud Deployment

For self-hosting the marketplace server, see `server/` directory:

```bash
cd server
docker compose up -d
```

Default port: 4111

## Development

```bash
# Type check
npx tsc --noEmit

# Test locally
openclaw gateway restart
tail -f ~/.openclaw/logs/gateway.log | grep unbrowse
```

### Key Directories

```
~/.openclaw/skills/           — Generated skills
~/.openclaw/extensions/       — Extension code
~/.openclaw/logs/             — Gateway logs
```

## Skill Format

Generated skills follow the [Agent Skills](https://agentskills.io) open standard:

```
my-skill/
├── SKILL.md          # Skill definition and metadata
├── scripts/          # Executable scripts
│   └── run.ts        # Main execution script
└── references/       # Supporting documentation
    └── api.md        # API reference
```

## License

MIT

---

*Built for OpenClaw. Powered by x402.*
