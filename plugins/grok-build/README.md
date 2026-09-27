# Unbrowse for Grok Build

Plugin: Unbrowse tools, the Unbrowse skill, and a redirect hook.

```sh
grok plugin install unbrowse-ai/unbrowse#plugins/grok-build --trust
npx unbrowse login            # OAuth, or: npx unbrowse login --key <ub_live_…>
```

## Why a local proxy

Grok drops MCP tools whose names contain anything besides letters, digits, `_` and `-`. The hosted server names its core tools `unbrowse.scrape`, `unbrowse.browse.open`, and so on, so Grok would see only site tools. The plugin runs `npx unbrowse mcp` instead: a stdio server that forwards to the hosted MCP with the CLI's login and lists tools as `unbrowse_scrape`, `unbrowse_browse_open`, … In Grok they appear as `unbrowse__unbrowse_scrape`.

## Replace the built-in browser

| Lever | Effect |
|---|---|
| `disable_web_search = true`, `[features] web_fetch = false` in `~/.grok/config.toml` | Removes `web_search` / `web_fetch` |
| Plugin PreToolUse hook | Denies `web_search`, remote `web_fetch`, `agent-browser open <remote url>`, browser MCPs; points to `unbrowse__unbrowse_*` |
| `sh <plugin>/scripts/install-global-hook.sh` | Same hook as a global `~/.grok/hooks/unbrowse.json` (`--remove` undoes it) |

Grok 1.0.41 discovers plugin hooks but did not dispatch them in our tests (headless and TUI); global hooks did. Use the installer until plugin hooks fire. Local pages stay allowed for App Builder QA (`127.0.0.1:8080`). Opt out with `UNBROWSE_ALLOW_BUILTIN_BROWSER=1`.

## Grok App Builder sandbox

The sandbox reads `.grok/skills/`. Copy `skills/unbrowse` there; the agent can call Unbrowse through `npx unbrowse` (REST) with `UNBROWSE_API_KEY` from the app's server-side env.
