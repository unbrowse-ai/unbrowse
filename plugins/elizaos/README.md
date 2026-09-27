# @unbrowse/plugin-unbrowse

Unbrowse for [elizaOS](https://github.com/elizaOS/eliza). Your agent can read pages, run tasks on websites through verified site APIs, and use a cloud browser, all through the hosted Unbrowse MCP (`https://unbrowse.ai/mcp`). The plugin replaces the default browser. It runs nothing locally.

Built for `@elizaos/core` 1.x (tested against 1.7.2). It also carries the 2.x action fields (`parameters`, `routingHint`, `contexts`).

## Install

```sh
bun add @unbrowse/plugin-unbrowse
# or, from an elizaOS project
elizaos plugins add @unbrowse/plugin-unbrowse
```

Get an API key from the Unbrowse console at https://unbrowse.ai/app.

## Configure

Store the key as a character secret or an environment variable. Don't commit it.

```json
{
  "name": "Researcher",
  "plugins": [
    "@elizaos/plugin-sql",
    "@unbrowse/plugin-unbrowse",
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-openai"
  ],
  "settings": {
    "secrets": { "UNBROWSE_API_KEY": "" }
  }
}
```

Leave `@elizaos/plugin-browser` out of `plugins`, and list Unbrowse before any other plugin that has a `WEB_FETCH` action (see [Replacing the default browser](#replacing-the-default-browser)).

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `UNBROWSE_API_KEY` | yes | | An API key (`ub_live_…`) or an OAuth access token. Sensitive. |
| `UNBROWSE_MCP_URL` | no | `https://unbrowse.ai/mcp` | The hosted MCP endpoint. |
| `UNBROWSE_END_USER` | no | | Org keys only: the end user each call is for, sent as `X-Unbrowse-End-User`. |
| `UNBROWSE_MAX_CHARS` | no | `8000` | Longest page or result text passed back to the agent. |
| `UNBROWSE_BROWSE_FALLBACK` | no | `true` | Set to `false` to stop `UNBROWSE_RUN` from opening the cloud browser on `no_capability`. |
| `UNBROWSE_RUN_TIMEOUT_MS` | no | `90000` | How long to poll a run that is still in progress. |
| `UNBROWSE_CHECK_CONNECTION` | no | `true` | Set to `false` to stop the provider's cached `tools/list` check. |

Settings are read with `runtime.getSetting` (from character `secrets`, `settings` or `settings.secrets`), then from `process.env`.

## Actions

| Action | Unbrowse tool | What it does |
|---|---|---|
| `WEB_FETCH` | `unbrowse.scrape` | Reads one page by URL and returns its main content as markdown, with the title and source. Pages that need JavaScript are rendered in the cloud browser. If that render fails (browser error or no free browser), the plugin retries once over plain HTTP and flags the result `renderFallback`. |
| `UNBROWSE_RUN` | `unbrowse.run` (then `unbrowse.inspect`) | Carries out a website task written in plain words, such as "top stories on hacker news". Unbrowse chooses a verified capability and calls the site's own API. |
| `UNBROWSE_DISCOVER` | `unbrowse.discover` | Lists the capabilities that match a need, with their ids and inputs. It runs nothing. |
| `UNBROWSE_BROWSE` | `unbrowse.browse.open`, then `.close` | Opens a URL in the cloud browser with a task, returns the rendered page text, and closes the session. Unbrowse records the visit and learns the site from it. |
| `UNBROWSE_RESUME` | `unbrowse.resume` | Answers the questions a paused run asked and continues the same run. |

The `UNBROWSE` provider adds a short note to the agent's context. The note says whether Unbrowse is configured and reachable (one cached `tools/list` call), which action to use for what, and any run still waiting for answers. The run steps and safety rules in the note come from `skill/SKILL.md`, which ships in this package.

Arguments come from the message text, so no model calls happen inside the handlers. A handler takes the first URL in the text, and the text itself is the task. On elizaOS 2.x, planner arguments passed in `options.parameters` (`url`, `task`, `capability`, `input`, `query`, `runId`, `answers`) take precedence over the text.

### How runs are reported

- **`succeeded`**: returns the result, and the capability id when there is one. This is the only status reported as done.
- **`input_required`**: the run is paused. The agent asks for the listed fields, such as `origin: Departure airport`, and remembers the run for the room. The user can then reply `origin: SFO, date: 2026-10-03`, or pick a choice by name or number, and `UNBROWSE_RESUME` answers the same run.
- **`no_capability`**: no reusable route fits. If a URL is known (from the message or the server's `next` hint), the task is done once in the cloud browser, and Unbrowse learns the site. Otherwise the agent asks for the site's URL. Either way, the plugin never reports success it didn't get.
- **Errors** return `success: false` with the server's code:
  - `browser_capacity` includes `retryAfter`, in seconds.
  - `invalid_token` says to replace the key.
  - A missing login returns the save-login link.
  - Quota errors return the top-up link.
  - `outcome_unknown` warns the user to check before retrying.

## Replacing the default browser

elizaOS keeps the first action registered under a given name, and later ones are skipped with a warning. To make sure web work goes to Unbrowse:

- **elizaOS 1.x**: leave `@elizaos/plugin-browser` out of the character's `plugins`. Put `@unbrowse/plugin-unbrowse` before any other plugin that has `WEB_FETCH`. 1.x registers character plugins concurrently. A plugin with an `init` registers its actions after one tick, which is why this plugin has no `init`.
- **elizaOS 2.x**: `@elizaos/plugin-browser` is a core plugin. Turn it off in `eliza.json`:

  ```json
  { "plugins": { "entries": { "browser": { "enabled": false } } } }
  ```

  The host's keyless `WEB_FETCH` fallback is registered only if no loaded plugin already provides `WEB_FETCH`. With this plugin loaded, `WEB_FETCH` is Unbrowse. Every action's `routingHint` also tells the planner to use Unbrowse, not `BROWSER`, for websites.

In 1.x, a planner action name is matched by exact name first, then by name substring, then by similes in registration order. `BROWSE_SITE` and `OPEN_SITE` reach `UNBROWSE_BROWSE`, and `READ_URL` reaches `WEB_FETCH`. `BROWSER` itself still goes to plugin-browser whenever plugin-browser is loaded, so remove plugin-browser.

## Security

- The key goes only in the `Authorization` header to the configured MCP URL. It never appears in action text, results, logs or the provider output.
- Website passwords never pass through the agent. A missing login returns a link where the user saves it with Unbrowse.
- Get the user's approval before any write, such as posting, sending or buying.

## Develop

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # offline: fake MCP, mock runtime and a real @elizaos/core 1.7.2 AgentRuntime
bun run build       # dist/index.js (bundles @unbrowse/sdk; @elizaos/core is a peer used for types only)
UNBROWSE_LIVE=1 UNBROWSE_API_KEY=… bun test tests/live.test.ts   # against the hosted service
```

The `skill/` folder is copied from the repository's `skill/` by `node scripts/sync-plugins.mjs`, run from the repo root. Don't edit it here.
