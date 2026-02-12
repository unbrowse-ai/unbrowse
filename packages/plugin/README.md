# Unbrowse

OpenClaw extension for reverse-engineering internal web APIs.

Unbrowse captures XHR/fetch traffic while you browse, turns it into an AgentSkills skill package (`SKILL.md`, `auth.json`, `scripts/`), and can publish/search/execute skills through a marketplace + proxy backend (x402 / Solana).

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
- `unbrowse_wallet`: create/import a Solana wallet for paid execution/publishing

## Marketplace

Defaults:
- Index URL: `https://index.unbrowse.ai`
- Override via config `skillIndexUrl` or env `UNBROWSE_INDEX_URL`.

Typical flow:

```bash
# 1) Create a wallet (private key stored in OS keychain by default)
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
- Proxy execution can require x402 payment (HTTP 402 + `X-Payment`).
- Skill download gating is optional policy; prioritize low-friction distribution and monetize on execution.
- Publishing requires a Solana private key to sign the publish request.
- Publishing contributes your skill + endpoint evidence to the shared index.
- Contribution rewards are paid in `FDRY` when indexed skills are used successfully (execution quality weighted).
- Marketplace executions run server-side through the backend executor abstraction.
- Local reverse-engineering usage is still available: capture/learn/replay can run locally without publishing.
- `FDRY` rewards can be used for execution flows where `FDRY` settlement is enabled.

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
          "publishValidationWithAuth": false,
          "skillIndexUrl": "https://index.unbrowse.ai",
          "credentialSource": "keychain",
          "enableChromeCookies": true,
          "enableDesktopAutomation": true
        }
      }
    }
  }
}
```

### Wallet Setup

Solana wallet credentials are managed separately from plugin config. Private keys are stored in OS keychain by default (no implicit file fallback). Never put private keys in `openclaw.json`.

```bash
# Create a new wallet (keypair generated locally, private key stored in keychain)
unbrowse_wallet action="create"

# Import an existing wallet
unbrowse_wallet action="import"
```

Wallet state is stored in `~/.openclaw/unbrowse/wallet.json` (public address + keychain flag only).

### Env Vars (optional)

- `UNBROWSE_INDEX_URL` — override the skill index URL
- `UNBROWSE_PUBLISH_TIMEOUT_MS` — publish request timeout in ms (default `300000`)
- `UNBROWSE_CREATOR_WALLET` — optional creator wallet bootstrap
- `UNBROWSE_SOLANA_PRIVATE_KEY` — optional one-time private key bootstrap into wallet storage
- `UNBROWSE_WALLET_ALLOW_FILE_PRIVATE_KEY=true` — explicitly allow private-key file fallback (CI/dev only)

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
