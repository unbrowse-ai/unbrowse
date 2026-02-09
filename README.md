# Unbrowse

OpenClaw extension for reverse-engineering internal web APIs.

Unbrowse captures XHR/fetch traffic while you browse, turns it into an AgentSkills skill package (`SKILL.md`, `auth.json`, `scripts/`), and can publish/search/download skills from a marketplace (x402 / Solana USDC).

Security note: Unbrowse runs locally. Captured auth (cookies/tokens) stays on your machine unless you explicitly publish a skill to the marketplace. See `SECURITY.md` for details.

## Installation

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
```

Supported hosts:
- OpenClaw
- Clawdbot
- Moltbot

## Core Tools

- `unbrowse_capture`: visit URLs and capture internal API traffic, then generate a local skill
- `unbrowse_learn`: parse a HAR file (or HAR JSON) and generate a local skill
- `unbrowse_login`: guided login flow to capture an authenticated session for a site
- `unbrowse_auth`: extract auth from a running browser session (cookies/tokens)
- `unbrowse_replay`: call captured endpoints with stored auth (auto-refresh supported when configured)
- `unbrowse_skills`: list local skills
- `unbrowse_publish`: publish a local skill folder to the marketplace
- `unbrowse_search`: search marketplace and optionally install by skill ID
- `unbrowse_wallet`: create/import a Solana wallet for paid downloads/publishing

## Marketplace

Defaults:
- Index URL: `https://index.unbrowse.ai`
- Override via config `skillIndexUrl` or env `UNBROWSE_INDEX_URL`.

Typical flow:

```bash
# 1) Create a wallet (stored in OS keychain on macOS; file fallback elsewhere)
unbrowse_wallet action="create"

# 2) Search for skills
unbrowse_search query="twitter"

# 3) Install a skill by ID
unbrowse_search install="<skillId>"

# 4) Publish one of your local skills (service = local skill directory name)
unbrowse_publish service="my-skill" price="0"
```

Notes:
- Search is free.
- Downloading a skill may require USDC via x402 (HTTP 402 + `X-Payment`).
- Publishing requires a Solana private key to sign the publish request.

## Configuration

Add to `~/.openclaw/openclaw.json` (or `~/.clawdbot/clawdbot.json`, `~/.moltbot/moltbot.json`):

```json
{
  "plugins": {
    "entries": {
      "unbrowse-openclaw": {
        "enabled": true,
        "config": {
          "skillsOutputDir": "~/.openclaw/skills",
          "autoDiscover": true,
          "autoContribute": true,
          "skillIndexUrl": "https://index.unbrowse.ai",

          "creatorWallet": "YOUR_SOLANA_ADDRESS",
          "skillIndexSolanaPrivateKey": "BASE58_PRIVATE_KEY",

          "enableChromeCookies": false,
          "enableOtpAutoFill": false,
          "enableDesktopAutomation": false
        }
      }
    }
  }
}
```

Env vars (optional):
- `UNBROWSE_INDEX_URL`
- `UNBROWSE_CREATOR_WALLET`
- `UNBROWSE_SOLANA_PRIVATE_KEY`

## Development

```bash
bun install
npx tsc --noEmit
```

### Tests

```bash
# Unit tests (fast)
bun run test

# Real-backend E2E (no mocking). Uses docker compose by default.
bun run test:e2e

# Black-box gateway E2E (OCT)
bun run test:oct
bun run test:oct:docker
```

E2E backend details: see `docs/LLM_DEV_GUIDE.md` and `test/e2e/backend-harness.ts`.

