# Unbrowse for OpenClaw

Websites as APIs inside OpenClaw. The plugin adds:

- **30 native tools**, one per core Unbrowse tool (`unbrowse_discover`, `unbrowse_run`, `unbrowse_scrape`, `unbrowse_browse_open` / `_act` / `_finish`, saved logins, canvas, usage and more). Each call goes to the hosted Unbrowse MCP.
- **A `web_fetch` provider** (`unbrowse`) backed by `unbrowse.scrape`, so JavaScript-heavy or blocked pages still come back as clean markdown.
- **A `before_tool_call` hook** that stops the built-in `browser` tool from opening web pages and points the agent at the Unbrowse tools. Local pages (`localhost`, `*.localhost`, `127.x`, `0.0.0.0`, `[::1]`) and non-web URLs (`about:`, `file:`) still go through.
- **The Unbrowse skill** (`skills/unbrowse`), which OpenClaw loads with the plugin.

Requires OpenClaw 2026.5.17 or later (tested with 2026.9.6) and an Unbrowse API key (`ub_live_…`) from https://unbrowse.ai.

## Install

From npm:

```bash
openclaw plugins install @unbrowse/openclaw --accept-capabilities
openclaw plugins enable unbrowse
```

From a checkout. `plugins install` copies the directory; add `--link` to load it in place while you develop:

```bash
cd plugins/openclaw && npm run build        # writes dist/index.js
openclaw plugins install ./plugins/openclaw --force --accept-capabilities
```

Local-path installs print a trust warning and stop unless you pass `--force`. Every install also needs `--accept-capabilities`, which records consent for the plugin's tools and skill.

## API key

Pick one:

- Put `UNBROWSE_API_KEY=ub_live_…` in the Gateway's environment. For a service, use `~/.openclaw/.env`, or `$OPENCLAW_STATE_DIR/.env` if you set that variable.
- Set `plugins.entries.unbrowse.config.apiKey` in `openclaw.json`.

The plugin config wins over the environment. `UNBROWSE_MCP_URL` and `UNBROWSE_END_USER` are read the same way.

## Replace the built-in browser

`~/.openclaw/openclaw.json` (JSON5):

```json5
{
  plugins: {
    entries: {
      unbrowse: {
        enabled: true,
        config: {
          // apiKey: "ub_live_…",          // or UNBROWSE_API_KEY
          // mcpUrl: "https://unbrowse.ai/mcp",
          // endUser: "customer-42",        // org keys only
          replaceBrowser: true,              // default: block `browser` for non-local URLs
          blockWebFetch: false,              // true: also block `web_fetch` for non-local URLs
        },
      },
      // Removes the built-in `browser` tool completely (the agent sees only the Unbrowse tools).
      // Leave it enabled if you still want the local browser for localhost QA; the hook covers web pages.
      browser: { enabled: false },
    },
  },
  tools: {
    web: {
      fetch: {
        provider: "unbrowse",   // web_fetch falls back to Unbrowse
      },
    },
  },
}
```

| Key | Default | Effect |
|---|---|---|
| `apiKey` | `UNBROWSE_API_KEY` | Unbrowse API key or OAuth access token |
| `mcpUrl` | `UNBROWSE_MCP_URL`, then `https://unbrowse.ai/mcp` | Hosted MCP endpoint |
| `endUser` | `UNBROWSE_END_USER` | Org keys: the end user a call is for |
| `replaceBrowser` | `true` | Block the built-in `browser` tool when it targets a non-local URL |
| `blockWebFetch` | `false` | Also block `web_fetch` for non-local URLs and point the agent at `unbrowse_scrape` |

How `web_fetch` uses the provider: OpenClaw fetches the page itself first. It calls the `unbrowse` provider only when that fetch fails, returns an error status, or extracts no content. To send every HTML page through Unbrowse, set `tools.web.fetch.readability: false`. To make agents call `unbrowse_scrape` directly, set `blockWebFetch: true`.

With a custom (non-bundled) web-fetch provider, the Gateway logs `[WEB_FETCH_PROVIDER_INVALID_AUTODETECT] tools.web.fetch.provider is "unbrowse"` at startup and on reload. That check runs in OpenClaw's credential resolver, which loads only bundled providers. `web_fetch` still resolves and calls the `unbrowse` provider (verified on 2026.9.6: the result reports `extractor: "unbrowse (http)"` and `externalContent.provider: "unbrowse"`).

### Why there is no replacement tool named `browser`

OpenClaw's `browser` tool exposes a large action set (`tabs`, `snapshot` with aria refs, `act` kinds, `pdf`, `upload`, `dialog`, profiles and more) over a local Chrome. Unbrowse's cloud browser offers a different flow: `open` → `snapshot` / `act` → `finish`. It also learns the route, so later calls need no browser. A drop-in `browser` tool would accept arguments it cannot honour. The plugin keeps Unbrowse's own tool names and uses the hook to redirect the agent.

## Errors

A failed call throws `Unbrowse <code>: <message>`, followed by a next step when one is known. Examples:

- `invalid_token`: check the key.
- `browser_capacity`: the cloud browser is busy. Retry in about 30 seconds, or use `unbrowse_scrape` with `render: "never"`.
- A tool result with `isError`: the server's text is passed through.

`input_required` is not an error. Answer it with `unbrowse_resume`.

## Verify

```bash
openclaw plugins list --json                      # unbrowse: enabled, loaded
openclaw plugins inspect unbrowse --runtime --json # 30 toolNames, webFetchProviderIds ["unbrowse"], typedHooks before_tool_call
openclaw plugins doctor                           # "…checks passed"
```

Call a tool without a model through the Gateway's `/tools/invoke` endpoint:

```bash
curl -s http://127.0.0.1:18789/tools/invoke \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tool":"unbrowse_scrape","args":{"url":"https://example.com"}}'
# browser → 403 tool_call_blocked, with the Unbrowse tools named in the message
curl -s http://127.0.0.1:18789/tools/invoke \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tool":"browser","args":{"action":"open","targetUrl":"https://example.com"}}'
```

`openclaw plugins validate` only covers `defineToolPlugin` / feature entries. This plugin registers hooks and a web-fetch provider, so it uses a plain plugin entry. Validate it with `inspect --runtime` and `doctor` instead.

## Develop

```bash
node scripts/sync-plugins.mjs   # at the repo root: refresh skills/unbrowse (never hand-edit it)
cd plugins/openclaw
npm run build       # dist/index.js (SDK bundled in) + contracts.tools regenerated from tools.json
npm test            # build, then bun test tests
npm run typecheck   # tsc --noEmit
npm run check       # fails if openclaw.plugin.json is stale
```
