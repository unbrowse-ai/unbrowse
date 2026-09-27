# Unbrowse for Claude Code

Plugin: the hosted Unbrowse MCP, the Unbrowse skill, and hooks that make Unbrowse the browser.

```sh
claude plugin marketplace add unbrowse-ai/unbrowse
claude plugin install unbrowse@unbrowse
```

(In a session: `/plugin marketplace add unbrowse-ai/unbrowse`, then `/plugin install unbrowse@unbrowse`.)

## Sign in

- OAuth (default): `/mcp` → `plugin:unbrowse:unbrowse` → Authenticate.
- API key: `npx unbrowse login --key <ub_live_…>`. The plugin's `headersHelper` reads the key from `~/.config/unbrowse/cli.json`. Claude Code strips `*KEY*`/`*TOKEN*` variables from the helper's environment, so `UNBROWSE_API_KEY` alone is not enough.
- Org keys: set `UNBROWSE_END_USER` to send `X-Unbrowse-End-User`.

## What changes

| Hook | Effect |
|---|---|
| SessionStart | Tells the model Unbrowse is the browser; names `unbrowse_scrape`, `unbrowse_discover` → `unbrowse_run`, `unbrowse_browse_*` |
| PreToolUse | Denies `WebFetch` (non-local), `WebSearch`, `agent-browser open/goto/navigate <remote url>`, Chrome (`mcp__claude-in-chrome__*`), Playwright, Puppeteer, Browserbase and Chrome DevTools MCPs. The reason tells the model which Unbrowse tool to use |

Local pages (`localhost`, `127.*`, `0.0.0.0`, `[::1]`) stay allowed for app QA. Opt out per session with `UNBROWSE_ALLOW_BUILTIN_BROWSER=1`.

To remove the built-in tools from context entirely (a plugin can't do this), add to your settings: `"permissions": {"deny": ["WebFetch", "WebSearch"]}`.

## Verify

```sh
claude plugin validate plugins/claude-code --strict
claude -p "Use WebFetch on https://example.com and give me the H1" --plugin-dir plugins/claude-code
```
