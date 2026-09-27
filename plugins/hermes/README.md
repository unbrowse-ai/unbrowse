# Unbrowse for Hermes Agent

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin that gives the agent the hosted
Unbrowse tools and moves public-web work off Hermes' built-in browser.

What it adds:

- **24 tools** in the `unbrowse` toolset, one per Unbrowse core tool: `unbrowse_scrape`,
  `unbrowse_discover`, `unbrowse_run`, `unbrowse_browse_open`/`_act`/`_snapshot`/`_finish`/`_close`,
  `unbrowse_credentials_*`, `unbrowse_map`, `unbrowse_sites`, `unbrowse_index`, `unbrowse_credits`, and
  more. Each call is a JSON-RPC `tools/call` to the hosted Unbrowse MCP. Dots in the MCP names become
  underscores, because OpenAI-style function names cannot contain dots. The tools are hidden until an
  API key is set.
- **A `web_extract` backend** named `unbrowse`: `web.extract_backend: unbrowse` sends Hermes'
  `web_extract` through `unbrowse.scrape`. Unbrowse has no general web search, so keep another
  `web_search` backend.
- **A `pre_tool_call` guard** that blocks `browser_*` tools on public sites and tells the model which
  Unbrowse tool to call instead. By default it also blocks `web_extract` on public URLs, unless the
  extract backend is already Unbrowse. Local pages (localhost, loopback, private networks, `*.local`,
  `file:`) still use the built-in browser, because the Unbrowse cloud cannot reach them.
- **The Unbrowse skill**, available as `skill_view("unbrowse:unbrowse")`.

The plugin uses only the Python standard library: `urllib`, no dependencies.

## Install

Every example below uses the default `~/.hermes`. If you set `HERMES_HOME` or use a profile, the
paths follow it.

```bash
# From GitHub (subdirectory install; Hermes downloads only this folder)
hermes plugins install unbrowse-ai/unbrowse/plugins/hermes --enable

# Or from a local checkout
cp -r plugins/hermes ~/.hermes/plugins/unbrowse        # or: ln -s "$PWD/plugins/hermes" ~/.hermes/plugins/unbrowse
hermes plugins enable unbrowse
```

User plugins are opt-in. Nothing loads until the plugin is in `plugins.enabled`, which `--enable` or
`hermes plugins enable unbrowse` adds. During an interactive install Hermes asks for
`UNBROWSE_API_KEY` and saves it to `~/.hermes/.env`. To set it yourself:

```bash
hermes config set UNBROWSE_API_KEY ub_live_...     # writes ~/.hermes/.env
```

Optional pip install, which Hermes finds through the `hermes_agent.plugins` entry point:

```bash
pip install "git+https://github.com/unbrowse-ai/unbrowse#subdirectory=plugins/hermes/pypi"
hermes plugins enable unbrowse
```

`pypi/pyproject.toml` sits in a subfolder for a reason. With a `pyproject.toml` next to
`plugin.yaml`, Hermes treats the plugin as having Python dependencies, asks for consent, and
`install --enable` will not enable it without a TTY.

## Configure

`~/.hermes/config.yaml`:

```yaml
plugins:
  enabled: [unbrowse]
  entries:
    unbrowse:
      settings:
        blockBrowser: true        # guard browser_* on public sites (default true)
        blockWebExtract: auto     # auto | "true" | "false"; auto = block unless web.extract_backend is unbrowse
        blockWebSearch: false     # Unbrowse has no general web search; keep web_search by default
        # mcpUrl: https://unbrowse.ai/mcp   # UNBROWSE_MCP_URL wins
        # endUser: customer-123            # org keys: X-Unbrowse-End-User (UNBROWSE_END_USER wins)
        # timeout: 180                     # seconds per call
        # apiKey: ...                      # works, but prefer UNBROWSE_API_KEY in .env

# web_extract through Unbrowse
web:
  extract_backend: unbrowse

# Remove the built-in browser toolset entirely (stronger than the guard; also drops local-page browsing)
agent:
  disabled_toolsets: [browser]
```

Environment variables: `UNBROWSE_API_KEY` (required), `UNBROWSE_MCP_URL`, `UNBROWSE_END_USER`, and
`UNBROWSE_ALLOW_BUILTIN_BROWSER=1`, which turns the guard off.

### Ways to replace the built-in browser

| Option | Effect |
|---|---|
| The guard (default) | `browser_navigate` to a public URL, and any `browser_*` call not preceded by a local navigation in the same task, returns a block message naming `unbrowse_scrape`, `unbrowse_discover` then `unbrowse_run`, and `unbrowse_browse_open`. Localhost stays usable. |
| `agent.disabled_toolsets: [browser]` | The model never sees the browser tools. `web_search`/`web_extract` are not in that toolset and stay available. |
| `web.extract_backend: unbrowse` | `web_extract` itself runs on Unbrowse. |
| `tools.override` | **Not used.** Overriding `browser_navigate` and the other browser tools would force Unbrowse's session model into Hermes' CDP/`@ref` snapshot contract, and it needs a separate capability grant. Separate `unbrowse_*` tools plus the guard give the same routing without replacing built-ins. |

## Verify

```bash
hermes plugins doctor ~/.hermes/plugins/unbrowse --ci   # 24 tool(s), 1 hook(s)
hermes plugins validate ~/.hermes/plugins/unbrowse
hermes plugins list                                      # unbrowse  enabled  user
HERMES_PLUGINS_DEBUG=1 hermes plugins list               # discovery trace
```

In a session, `/plugins` lists `unbrowse v0.1.0 (24 tools, 1 hooks)`. Then ask for something like
"read https://example.com". The model should call `unbrowse_scrape`, and a `browser_navigate` to a
public site gets blocked with guidance.

`hermes plugins list` reports a subdirectory install as `provenance: drift`, because the installed
folder has no `.git`. `hermes plugins update` cannot track it, so reinstall with `--force` to update.

## Always-visible skill

Plugin skills are loaded explicitly (`skill_view("unbrowse:unbrowse")`) and are not in the system
prompt's skill index. To list the skill there:

```yaml
skills:
  external_dirs:
    - ~/.hermes/plugins/unbrowse/skills
```

or `hermes skills install unbrowse-ai/unbrowse/skill`.

## Alternative: config only, no plugin

Hermes can mount the remote MCP itself. This needs Hermes' `mcp` extra, because the `mcp` Python SDK
is not a core dependency:

```yaml
mcp_servers:
  unbrowse:
    url: https://unbrowse.ai/mcp
    headers:
      Authorization: "Bearer ${UNBROWSE_API_KEY}"
      mcp-protocol-version: "2025-11-25"   # the server refuses 2025-06-18 on its streaming path
```

Hermes sanitizes MCP tool names: every character outside `[A-Za-z0-9_]` becomes `_`, and the name
gets the prefix `mcp__<server>__`. `unbrowse.scrape` becomes `mcp__unbrowse__unbrowse_scrape`, cut to
64 characters with a hash suffix when longer. This path also lists workspace-learned site tools
(`tools/list`). It has no browser guard, no `web_extract` backend and no bundled skill.

## Tests

```bash
cd plugins/hermes
python -m pytest tests -q          # inside a Hermes venv; host tests skip when Hermes is not importable
HERMES_PYTHON=/path/to/hermes/venv/bin/python python -m pytest tests -q
UNBROWSE_LIVE=1 UNBROWSE_API_KEY=... python -m pytest tests/test_live.py -q   # hosted, opt-in
```

The host tests run the plugin in real Hermes with a throwaway `HERMES_HOME`. They cover the plugin
loader, the tool registry, `model_tools.handle_function_call`, `web_extract` routing and Plugin Doctor.

`skills/unbrowse` is copied from the repo's `skill/` directory by `node scripts/sync-plugins.mjs`. Do
not edit the copy.
