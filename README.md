# Unbrowse (OpenClaw Plugin & Skill Ecosystem)

[![Star History Chart](https://api.star-history.com/svg?repos=lekt9/unbrowse-openclaw&type=date&legend=top-left)](https://www.star-history.com/#lekt9/unbrowse-openclaw&type=date&legend=top-left)

Open source API reverse engineering for OpenClaw.

Unbrowse captures real browser network traffic and turns it into reusable agent skills.

> Security note: core capture/replay is local by default. Data is kept on your machine unless you explicitly publish. See [`SECURITY.md`](SECURITY.md).

## Why this project exists

Agents that drive websites through browser automation are slow and brittle:

- full browser startup
- DOM waits and selector drift
- repeated render/parse loops for every action

Unbrowse short-circuits that path:

- first run: observe with browser to capture real traffic
- later runs: call the same behavior directly through inferred endpoint contracts

Result: faster execution and fewer UI-shape failures in action-heavy workflows.

This is the practical “agentic web” move: agents should execute capability contracts, not scrape screen pixels.

## Quick Start (works without config)

### 1) Install

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
openclaw gateway restart
```

### 2) Capture a local skill

```text
unbrowse_capture { "urls": ["https://example.com"] }
```

### 3) Replay immediately

```text
unbrowse_replay { "service": "example" }
```

### What’s needed for each feature

| Feature | What you need |
|---|---|
| Capture APIs | nothing extra |
| Generate artifacts | nothing extra |
| Replay local | nothing extra |
| Browse/login capture | browser session |
| Search shared skills | nothing extra |
| Publish/install sharing | marketplace route (optional) |
| Wallet payout flows | **inactive in this repo** |

> Payments are not enabled. Wallet tooling and config fields may exist, but settlement remains inactive.

## System layout

- `packages/plugin`: local capture, inference, local replay, local artifact writes.
- `server` + `packages/web`: optional publish/search/install contracts, shared execution routes, validation merge surface.

The same command line can stay local-only indefinitely; marketplace participation is opt-in.

## The 100x story (practical framing)

### Browser-automation path

- launch browser
- render page
- wait for JS hydration
- inspect DOM / click and type
- scrape rendered output

### Unbrowse path after learn

- execute the captured endpoint contract (`GET`, `POST`, etc.)
- reuse inferred auth/session context
- run deterministic request/response flows

The gain is not a “small optimization.”
It is often the difference between workflows that stall and ones that feel immediate.

## How it works

1. **Capture**  
   `unbrowse_capture` records network traffic from your session.
2. **Learn / infer**  
   Endpoints, methods, auth styles, and request shapes are inferred.
3. **Generate**  
   Skill artifacts are written locally:
   - `~/.openclaw/skills/<service>/SKILL.md`
   - `scripts/`
   - optional `references/`
   - optional `auth.json`
4. **Replay**  
   `unbrowse_replay` executes locally first via browser/node mode.
5. **Publish (optional)**  
   `unbrowse_publish` proposes shareable artifacts; server validates + merges and exposes searchable IDs.
6. **Install / execute (optional)**  
   `unbrowse_search` can install discovered IDs into your local flow.

## Core data and runtime boundary

| Area | Local runtime | Remote/runtime contracts |
|---|---|---|
| Capture | ✅ local sessions | ❌ not required |
| Replay | ✅ local artifacts | ⏯️ optional backend path |
| Auth/session storage | ✅ local-first | ✅ explicit placeholder boundaries |
| Search/discover | ❌ | ✅ |
| Execution contracts | local fallback exists | optional through backend endpoint IDs |

`payments` are intentionally not active in this repository.

## Why local-first + publish-at-will

- private work should not depend on the index
- private credentials stay local
- shareable behavior is still possible after publish
- reusable ecosystem growth without forcing central lock-in

## Plugin configuration

Set your plugin block in OpenClaw as `plugins.entries.unbrowse-openclaw.config`.

```json
{
  "plugins": {
    "entries": {
      "unbrowse-openclaw": {
        "config": {
          "browserPort": 8891,
          "browserProfile": "",
          "allowLegacyPlaywrightFallback": false,
          "skillsOutputDir": "~/.openclaw/skills",
          "autoDiscover": true,
          "autoContribute": true,
          "enableAgentContextHints": false,
          "publishValidationWithAuth": false,
          "skillIndexUrl": "https://index.unbrowse.ai",
          "creatorWallet": "",
          "skillIndexSolanaPrivateKey": "",
          "credentialSource": "none",
          "enableChromeCookies": false,
          "enableDesktopAutomation": false,
          "telemetryEnabled": true,
          "telemetryLevel": "standard"
        }
      }
    }
  }
}
```

| Option | Default | What it does |
|---|---|---|
| `browserPort` | `OPENCLAW_GATEWAY_PORT` / `CLAWDBOT_GATEWAY_PORT` / `config.gateway.port` / `18789`, then `+2` | Browser bridge port for session tools |
| `browserProfile` | open-claw root default profile | Browser context profile selector |
| `allowLegacyPlaywrightFallback` | `false` | Enable Playwright fallback on direct browser flow |
| `skillsOutputDir` | `~/.openclaw/skills` | Skill write location |
| `autoDiscover` | `true` | Reuse previously captured skill hints automatically |
| `autoContribute` | `true` | Auto-contribute publish flow when enabled |
| `enableAgentContextHints` | `false` | Add captured-session context hints |
| `publishValidationWithAuth` | `false` | Validate publish calls with auth context |
| `skillIndexUrl` | `UNBROWSE_INDEX_URL` / `https://index.unbrowse.ai` | Marketplace/search base URL |
| `creatorWallet` | saved wallet or `UNBROWSE_CREATOR_WALLET` | Creator payout wallet |
| `skillIndexSolanaPrivateKey` | `UNBROWSE_SOLANA_PRIVATE_KEY` | Payer private key for marketplace operations |
| `credentialSource` | `UNBROWSE_CREDENTIAL_SOURCE` or `none` | Credential lookup: `none`, `vault`, `keychain`, `1password` |
| `enableChromeCookies` | `false` | Allow Chrome cookie read path |
| `enableDesktopAutomation` | `false` | Enable `unbrowse_desktop` |
| `telemetryEnabled` | `true` | Send usage telemetry to index |
| `telemetryLevel` | `standard` | Telemetry payload detail: `minimal`, `standard`, `debug` |

Plugin env helpers:

- `OPENCLAW_GATEWAY_PORT` / `CLAWDBOT_GATEWAY_PORT`
- `UNBROWSE_INDEX_URL`
- `UNBROWSE_CREATOR_WALLET`
- `UNBROWSE_SOLANA_PRIVATE_KEY`
- `UNBROWSE_CREDENTIAL_SOURCE`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`

Local override:

- `~/.openclaw/unbrowse/telemetry.json` with `{ "enabled": boolean, "level": "minimal" | "standard" | "debug" }` takes precedence over `telemetryEnabled` / `telemetryLevel`.

## What isn’t documented (and why)

We intentionally treat these as black-box/internal:

- ranking internals
- settlement routing internals
- partner execution topology

The docs focus on:

- tool contracts
- observable inputs/outputs
- merge/conflict behavior
- security boundaries

## Local and shared command map

- **Capture / learn**
  - `unbrowse_browse`
  - `unbrowse_capture`
  - `unbrowse_learn`
  - `unbrowse_login`
  - `unbrowse_auth`
- **Skill/runtime execution**
  - `unbrowse_replay`
  - `unbrowse_skills`
- **Marketplace**
  - `unbrowse_search`
  - `unbrowse_publish`
- **Automation helpers**
  - `unbrowse_do`
  - `unbrowse_desktop`
- **Workflows**
  - `unbrowse_workflow_record`
  - `unbrowse_workflow_learn`
  - `unbrowse_workflow_execute`
  - `unbrowse_workflow_stats`
- **Wallet/config**
  - `unbrowse_wallet` (currently inactive for settlement path in this repo)

## Installation options

### Recommended

`openclaw plugins install @getfoundry/unbrowse-openclaw`

### Manual JSON install

Add to your OpenClaw config (or equivalent runtime config file):

```json
{
  "plugins": {
    "entries": {
      "unbrowse-openclaw": {
        "enabled": true
      }
    }
  }
}
```

Then:

```bash
openclaw gateway restart
```

### Run from source

```bash
git clone https://github.com/lekt9/unbrowse-openclaw ~/.openclaw/extensions/unbrowse-openclaw
cd ~/.openclaw/extensions/unbrowse-openclaw
npm install
openclaw gateway restart
```

## Next reads

1. `docs/AGENTIC_WEB.md`
2. `docs/ARCHITECTURE.md`
3. `docs/INTEGRATION_BOUNDARIES.md`
4. `docs/CONTRIBUTOR_PLAYBOOK.md`
5. `docs/PURPOSE.md`
