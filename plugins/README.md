# Host plugins

Each plugin ships the Unbrowse skill (`skill/`, synced by `node scripts/sync-plugins.mjs`), connects the hosted MCP, and makes Unbrowse the host's browser as far as the host allows.

| Host | Install | Tools | How the built-in browser is replaced |
|---|---|---|---|
| [Claude Code](claude-code/README.md) | `claude plugin marketplace add unbrowse-ai/unbrowse` · `claude plugin install unbrowse@unbrowse` | hosted MCP (http; OAuth or `unbrowse login --key`) | PreToolUse hook denies `WebFetch`, `WebSearch`, remote `agent-browser`, Chrome/Playwright/Puppeteer/Browserbase MCPs; SessionStart context |
| [Codex](codex/README.md) | `codex plugin marketplace add unbrowse-ai/unbrowse` · `codex plugin add unbrowse@unbrowse` | hosted MCP (streamable-http, OAuth) | SessionStart context; PreToolUse denies remote `agent-browser` and browser MCPs; `web_search = "disabled"` (hosted search can't be hooked) |
| [Grok Build](grok-build/README.md) | `grok plugin install unbrowse-ai/unbrowse#plugins/grok-build --trust` | `npx unbrowse mcp` (stdio; Grok rejects dotted tool names) | redirect hook (plugin, or global via `install-global-hook.sh`); `disable_web_search = true` |
| [Cursor / Grok Bot](cursor/README.md) | Cursor Marketplace (Grok Bot installs from the same marketplace) | hosted MCP (`https://unbrowse.ai/mcp`, OAuth) | always-on rule sends web work to Unbrowse |
| [OpenClaw](openclaw/README.md) | `openclaw plugins install @unbrowse/openclaw --accept-capabilities` | 24 native tools | `before_tool_call` blocks the `browser` tool for remote URLs; Unbrowse `web_fetch` provider; disable the bundled `browser` plugin |
| [Hermes](hermes/README.md) | `hermes plugins install unbrowse-ai/unbrowse/plugins/hermes --enable` | 24 native tools | `pre_tool_call` guard on `browser_*` and `web_extract`; `web.extract_backend: unbrowse`; `agent.disabled_toolsets: [browser]` |
| [elizaOS](elizaos/README.md) | `bun add @unbrowse/plugin-unbrowse` | actions `WEB_FETCH`, `UNBROWSE_RUN`, `UNBROWSE_DISCOVER`, `UNBROWSE_BROWSE`, `UNBROWSE_RESUME` + provider | owns `WEB_FETCH` (first registration wins; list it first); remove `@elizaos/plugin-browser` |
| [Dify](dify/README.md) | Dify Marketplace → Unbrowse (or upload the `.difypkg`) | tool plugin: Scrape Page, Discover, Run Task (hosted API, `UNBROWSE_API_KEY`) | none: Dify tools are opt-in per app |

All of them keep local pages (`localhost`, `127.*`) open for app QA, and `UNBROWSE_ALLOW_BUILTIN_BROWSER=1` turns the redirect off for a session.

## Test

```sh
bun run check:plugins                 # skill + shared hook scripts in sync
bun test ./tests                      # Claude Code, Codex, Grok manifests and hooks
(cd plugins/openclaw && bun test tests)
(cd plugins/elizaos && bun install && bun test tests)   # UNBROWSE_LIVE=1 for live calls
python -m pytest plugins/hermes/tests                  # UNBROWSE_LIVE=1 for live calls
python -m pytest plugins/dify/tests                    # needs dify_plugin; UNBROWSE_LIVE=1 + UNBROWSE_API_KEY for live calls
```

Host-level checks run against the real hosts are listed in each plugin's README.

Dify package: `dify plugin package plugins/dify -o unbrowse-<version>.difypkg` (CLI from [dify-plugin-daemon releases](https://github.com/langgenius/dify-plugin-daemon/releases)), then `python3 validator/validate-difypkg.py unbrowse-<version>.difypkg` from [dify-marketplace-toolkit](https://github.com/langgenius/dify-marketplace-toolkit). A Marketplace update is a PR to langgenius/dify-plugins adding only `unbrowse/unbrowse/unbrowse-<version>.difypkg`, with the version bumped in `manifest.yaml`.
