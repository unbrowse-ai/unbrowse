# Unbrowse OpenClaw Plugin [DEPRECATED]

> **This OpenClaw plugin is deprecated.** Unbrowse is now a standalone, agent-agnostic skill that works with any coding agent — Claude Code, Cursor, Codex, Windsurf, and more. The plugin-specific approach tied functionality to a single platform; the new skill runs as a local server with a shared marketplace, so every agent benefits from the same discovered APIs.
>
> **Migrate to the universal skill:** see the install instructions below.

---

[![Star History Chart](https://api.star-history.com/svg?repos=lekt9/unbrowse-openclaw&type=date&legend=top-left)](https://www.star-history.com/#lekt9/unbrowse-openclaw&type=date&legend=top-left)

## Why deprecate the plugin?

The OpenClaw plugin required a specific runtime (`openclaw gateway`), specific tool names (`unbrowse_capture`, `unbrowse_replay`), and OpenClaw-specific config. This locked out every other agent ecosystem.

The replacement is a lightweight local server (`localhost:6969`) that any agent can call via standard HTTP. Skills discovered by one agent are published to a shared marketplace and instantly reusable by all agents on the network. No plugin system, no gateway, no vendor lock-in.

## Migration

### Before (OpenClaw plugin)

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
openclaw gateway restart
# then use unbrowse_capture, unbrowse_replay, etc.
```

### After (universal skill)

```bash
git clone https://github.com/lekt9/unbrowse-openclaw ~/.agents/skills/unbrowse
bash ~/.agents/skills/unbrowse/scripts/setup.sh
```

The server starts on `http://localhost:6969`. Your agent talks to it via `POST /v1/intent/resolve` — describe what you want in natural language and the skill handles marketplace search, live capture, and execution automatically.

For Claude Code, install the `SKILL.md` as a skill. For other agents, point them at the local HTTP API.

## How the new skill works

1. You provide a URL and intent (e.g. "get trending searches on Google")
2. The marketplace is searched for an existing skill matching your intent
3. If found, the skill executes immediately (50-200ms)
4. If not found, a headless browser navigates to the URL and records all network traffic
5. API endpoints are extracted, scored, and filtered from the traffic
6. A reusable skill is published to the shared marketplace
7. Future calls — from any agent — reuse the learned skill instantly

## What stays the same

- Core idea: capture real browser traffic, infer API contracts, replay without a browser
- Local-first: credentials and captures stay on your machine unless you explicitly publish
- Marketplace: shared skill discovery and reuse across agents
- Security model: see [`SECURITY.md`](SECURITY.md)

## What changed

| | Old (plugin) | New (skill) |
|---|---|---|
| Runtime | OpenClaw gateway | Standalone local server (Bun) |
| Agent support | OpenClaw only | Any agent (Claude Code, Cursor, Codex, etc.) |
| Interface | OpenClaw tool calls | HTTP API (`localhost:6969`) |
| Install | `openclaw plugins install` | `git clone` + `bash setup.sh` |
| Marketplace | `index.unbrowse.ai` | `beta-api.unbrowse.ai` (auto-proxied) |
| Config | OpenClaw plugin JSON block | `~/.unbrowse/config.json` (auto-generated) |

## Legacy documentation

The following docs describe the old plugin architecture and are kept for reference:

- `docs/ARCHITECTURE.md` — original system design
- `docs/AGENTIC_WEB.md` — vision document
- `docs/INTEGRATION_BOUNDARIES.md` — security boundaries
- `PROTOCOL.md` — wire protocol
- `CONTRIBUTING.md` — contribution guide
- `GOVERNANCE.md` — project governance

## Legacy plugin configuration (archived)

<details>
<summary>OpenClaw plugin config (no longer needed)</summary>

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

</details>

## License

AGPL-3.0 — see [LICENSE](LICENSE).
