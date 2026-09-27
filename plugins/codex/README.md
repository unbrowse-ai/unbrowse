# Unbrowse for Codex

Plugin: the hosted Unbrowse MCP, the Unbrowse skill, and hooks that steer web work to Unbrowse.

```sh
codex plugin marketplace add unbrowse-ai/unbrowse
codex plugin add unbrowse@unbrowse
codex mcp login unbrowse          # OAuth
```

Codex asks you to review the plugin's hooks (`/hooks`) before they run.

## API key instead of OAuth

A plugin's `.mcp.json` can't carry a bearer token. Put this in `~/.codex/config.toml`; a user server of the same name takes over the plugin's:

```toml
[mcp_servers.unbrowse]
url = "https://unbrowse.ai/mcp"
bearer_token_env_var = "UNBROWSE_API_KEY"
```

## Replace the built-in browser

| Lever | Effect |
|---|---|
| SessionStart hook | Tells the model Unbrowse is the browser (`mcp__unbrowse__unbrowse_*`) |
| PreToolUse hook | Denies `agent-browser open <remote url>` and Playwright/Puppeteer/Browserbase/Chrome DevTools MCPs |
| `web_search = "disabled"` in `config.toml` | Removes Codex's hosted web search. Hooks can't intercept it (Codex docs: hosted tools skip PreToolUse), so this is the only off switch |

MCP calls need approval in `codex exec`; allow them with `[mcp_servers.unbrowse] default_tools_approval_mode = "approve"`.

Opt out of the redirect per session: `UNBROWSE_ALLOW_BUILTIN_BROWSER=1`.

Note: Codex 0.156 loads a plugin's hooks only from the legacy `.codex-plugin/plugin.json` manifest; the root `plugin.json` (Agent Plugins) form installed but skipped them. That is why this plugin uses the legacy layout.
