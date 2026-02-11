# Unbrowse

**Open source API reverse engineering for OpenClaw.**

Unbrowse is an [OpenClaw](https://github.com/lekt9/openclaw) extension that captures API traffic from any website and turns it into monetizable skills for AI agents. Browse a site, capture the API calls, generate skills, and publish them to the marketplace to earn USDC on every download.

> **🔒 Security Note:** Unbrowse runs locally and accesses browser sessions to automate logins. All data stays on your machine — nothing is transmitted externally unless you explicitly publish to the marketplace. See [SECURITY.md](SECURITY.md) for full details on what's accessed and why.

```
┌─────────────────────────────────────────────────────────────┐
│                        UNBROWSE                             │
│          Open Source API Reverse Engineering                │
│                                                             │
│   Capture ──► Generate ──► Publish ──► Earn                │
│       │          │           │          │                   │
│       ▼          ▼           ▼          ▼                   │
│   API traffic  skills    marketplace   USDC                │
│   auth headers schemas   x402 payments 70% revenue         │
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
      "unbrowse-openclaw": { "enabled": true }
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
      "unbrowse-openclaw": {
        "enabled": true,
        "source": "github:lekt9/unbrowse-openclaw"
      }
    }
  }
}
```

### Option D: Manual Clone

```bash
git clone https://github.com/lekt9/unbrowse-openclaw ~/.openclaw/extensions/unbrowse-openclaw
cd ~/.openclaw/extensions/unbrowse-openclaw && npm install
npm run build
openclaw gateway restart
```

## Quick Start — No Config Needed! 🚀

**Unbrowse works immediately after installation.** No API key required for core features:

```bash
# Install and start using right away
openclaw plugins install @getfoundry/unbrowse-openclaw

# Start capturing immediately - no config needed
"Capture the API from airbnb.com"
```

### What Needs What

| Feature | Requirements |
|---------|-------------|
| **Capture APIs** | ✅ Nothing — works out of box |
| **Generate skills** | ✅ Nothing — works out of box |
| **Replay captured APIs** | ✅ Nothing — uses your captured auth |
| **Browse & login** | ✅ Nothing — uses your Chrome profile |
| **Search marketplace** | ✅ Nothing — free to search |
| **Download from marketplace** | 💰 Solana wallet + USDC ($0.01/skill) |
| **Publish to marketplace** | 💰 Solana wallet (earn 70% revenue) |

### Setting Up Marketplace (Optional)

Only needed if you want to download/publish skills to the marketplace:

```bash
# Create a Solana wallet for marketplace transactions
unbrowse_wallet action="create"

# Or use your existing wallet
unbrowse_wallet action="set_creator" wallet="<your-solana-address>"
```

> **Note:** The `SOLANA_PRIVATE_KEY` and `UNBROWSE_API_KEY` environment variables are only for advanced marketplace features. Basic capture, generation, and replay work without any configuration.

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
- **70%** goes to you (the creator)
- **30%** goes to the platform

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

### Workflow Skills (NEW)

| Tool | Description |
|------|-------------|
| `unbrowse_workflow_record` | Record multi-site browsing sessions for workflow learning |
| `unbrowse_workflow_learn` | Analyze recordings to generate api-package or workflow skills |
| `unbrowse_workflow_execute` | Execute workflow or api-package skills with success tracking |
| `unbrowse_workflow_stats` | View success rates, earnings, and leaderboards |

## Skill Categories

Unbrowse generates two types of skills:

### API Packages (`api-package`)
Single-site API collections. Simple endpoint capture with authentication.

```bash
# Capture and generate
unbrowse_capture url="api.twitter.com"
# Generates: twitter-api skill with endpoints
```

### Workflows (`workflow`)
Multi-site orchestration with decision points and data flow.

```bash
# Record a cross-site session
unbrowse_workflow_record action="start" intent="Compare prices across sites"
# Browse multiple sites, add annotations at key points
unbrowse_workflow_record action="annotate" note="Price comparison" noteType="decision"
unbrowse_workflow_record action="stop"
# Learn the workflow
unbrowse_workflow_learn sessionId="session-123..."
```

## Earnings Model

**Pay per sale. Buyers own the skill forever.**

When an agent purchases a skill:
- **70%** goes to the creator
- **30%** goes to the platform

Payments are instant via x402 protocol on Solana (USDC).

```
┌─────────────────────────────────────────────────┐
│              EARNINGS BREAKDOWN                 │
├─────────────────────────────────────────────────┤
│  Creator:  70%  ─ Instant payout on sale        │
│  Platform: 30%  ─ Infrastructure & marketplace  │
└─────────────────────────────────────────────────┘
```

### Quality Tiers (Marketplace Ranking)

Success rate affects marketplace visibility. Higher quality = more sales.

| Tier | Success Rate | Visibility |
|------|-------------|------------|
| Gold | 95%+ | Featured, top ranking |
| Silver | 85%+ | High visibility |
| Bronze | 70%+ | Standard listing |
| Unranked | 50%+ | Lower ranking |
| Poor | <50% | Hidden from search |

## Configuration

Full config example:

```json
{
  "plugins": {
    "entries": {
      "unbrowse-openclaw": {
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

### Security Options (all disabled by default)

| Option | Default | Description |
|--------|---------|-------------|
| `enableChromeCookies` | `false` | Read cookies from Chrome's database |
| `enableOtpAutoFill` | `false` | Auto-fill OTP codes from SMS/clipboard |
| `enableDesktopAutomation` | `false` | Allow AppleScript desktop control |

See [SECURITY.md](SECURITY.md) for detailed explanations of each feature.

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
| Paid | $0.10 - $100 | Creator sets price, earns 70% |

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

## Troubleshooting

### "Given napi value is not an array" or "Failed to convert JavaScript value"

This error occurs on **Node.js v24+** due to N-API compatibility issues with the `@solana/web3.js` native bindings.

**Solution:** Use Node.js v22 LTS (Long Term Support)

```bash
# If using nvm
nvm install 22
nvm use 22

# Then restart the gateway
openclaw gateway restart
```

### "Native module failed to load" (ESM Error)

Fixed in v0.4.0+. Update to the latest version:

```bash
openclaw plugins update @getfoundry/unbrowse-openclaw
```

### unbrowse_skills returns undefined

Usually a Node version issue. See the Node.js v24+ fix above.

### Wallet operations fail

Wallet/marketplace features require:
1. Node.js v22 or earlier (not v24+)
2. A funded Solana wallet (for downloads)

Basic capture, generation, and replay work without a wallet.

### Chrome won't connect

Make sure Chrome is running with remote debugging enabled, or let Unbrowse launch it:

```bash
# Kill existing Chrome instances
pkill -f "Google Chrome"

# Try capture again (Unbrowse will launch Chrome)
unbrowse_capture urls=["https://example.com"]
```

## Changelog

### v0.6.0 (Breaking Changes)

**Security: All sensitive features now disabled by default**

The following capabilities now require explicit opt-in via config:

| Feature | Config to Enable |
|---------|------------------|
| Chrome cookie reading | `enableChromeCookies: true` |
| OTP auto-fill (SMS/clipboard) | `enableOtpAutoFill: true` |
| Desktop automation (AppleScript) | `enableDesktopAutomation: true` |
| Keychain/1Password credentials | `credentialSource: "keychain"` |

**Why:** These features access sensitive local data. While necessary for full automation, they should be opt-in so users understand what they're enabling.

**Migration:** Add to your config if you need these features:
```json
{
  "plugins": {
    "entries": {
      "unbrowse": {
        "config": {
          "enableChromeCookies": true,
          "enableOtpAutoFill": true,
          "enableDesktopAutomation": true
        }
      }
    }
  }
}
```

**Core capture/replay functionality is unaffected** — basic API capture and replay work without any config changes.

See [SECURITY.md](SECURITY.md) for full details on what each feature does.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=lekt9/unbrowse-openclaw&type=Date)](https://star-history.com/#lekt9/unbrowse-openclaw&Date)

## License

GNU Affero General Public License v3.0 (`AGPL-3.0-only`).

This requires preserving copyright/license notices and sharing source
for networked derivatives under the same license.

---

*Built for OpenClaw. Powered by x402.*
