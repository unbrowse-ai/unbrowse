# Unbrowse for OpenClaw

An [OpenClaw](https://github.com/openclaw/openclaw) plugin for the Unbrowse node on your machine. Say what you want
from a website and get the site's own JSON back. The node calls the route that does it, or learns one from the page
and calls that. When a page needs clicks or typing, the agent drives the node's browser, and the node learns from
every step.

A **route** is a website's own API call, learned once by the node's browser and replayed after that as plain HTTP.

The plugin adds every agent tool the node serves (`unbrowse_search`, `unbrowse_do`, `unbrowse_walk`,
`unbrowse_browse`, `unbrowse_challenge`, `unbrowse_observe`, `unbrowse_logins`, `unbrowse_open`, `unbrowse_call`,
`unbrowse_inspect`, `unbrowse_judge`, `unbrowse_whoami` and `unbrowse_report`) and the `unbrowse` skill, which tells
the agent how to use them. The tools are the
[`unbrowse`](../../unbrowse-sdk/typescript) TypeScript client's `unbrowse/tools`, written from the node's own
`agent-api.json`, so their names, descriptions and input schemas are the node's MCP server's, word for word. The client
is bundled into the plugin, so it has no dependencies. It needs OpenClaw 2026.10.8 or later.

## Install

Start the node first: `npm install -g unbrowse`, then `unbrowse app` (or `unbrowse start` with no window). It needs
no account and no sign-in: it joins the network with its own wallet (spec §86), and linking a wallet of yours is
optional, only for cashing out ([ONBOARDING.md](../../docs/ONBOARDING.md#2-linking-a-wallet-optional)).

```bash
openclaw plugins install npm:@unbrowse/openclaw-plugin --accept-capabilities
```

From this directory, before it is published:

```bash
npm install && npm run build && npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/unbrowse-openclaw-plugin-0.1.0.tgz --force --accept-capabilities
openclaw plugins inspect unbrowse --runtime
```

`npm run build` needs the SDK built first (`npm ci && npm run build` in `unbrowse-sdk/typescript`).

## Connect

The node makes its first agent key itself on its first run, and `unbrowse agent token` prints that key's token. For
an OpenClaw-specific key, `unbrowse agent new openclaw` (or the window's Agents, Add agent) makes one and prints its
setup once. Set that key in this plugin's `agentToken` configuration for this agent. The plugin never reads a
process-wide `UNBROWSE_AGENT_TOKEN`, which could belong to another agent.

```json5
{
  plugins: {
    entries: {
      unbrowse: {
        config: {
          node: "http://127.0.0.1:7788",
          agentToken: "<this agent's token>"
        }
      }
    }
  }
}
```

The plugin's own config, `plugins.entries.unbrowse.config`, takes two keys:

| Key | Default | What it is |
|---|---|---|
| `node` | `UNBROWSE_NODE`, then `http://127.0.0.1:7788` | The node's address. |
| `agentToken` | required | This agent's token. A missing value fails closed; the plugin never borrows a process-wide token. |

```bash
openclaw config set plugins.entries.unbrowse.config.node http://127.0.0.1:7788
```

## Tools

Each tool is the node's MCP tool of the same name, with its description and input schema
([CLI.md §5](../../docs/CLI.md#5-the-agent-api-and-mcp-tools) lists them). `unbrowse_do` says what you want and gets
the site's JSON back; its reply's `how` says which way it went: `called` (a route did it), `network` (another
contributor's route, whose fee the node paid itself from its balance), `learned` (the node walked `url` and kept the
call), or `browse` (the page needs hands: it is open in the node's browser, and `page` is a snapshot of it).
`unbrowse_browse` drives that page; its calls run one at a time, and all the plugin's calls share one browsing
session, so each step acts on the page the last one opened.

A tool answers what the MCP server would: the node's JSON in its own field names (`route_for_goal`,
`possible_commit`, `retry`), or `{ "error", "code" }` when the node refuses or can't be reached (no token, node not
running, paused, no route for the goal), so the model reads what went wrong. A call that reached the site and didn't
pass is a result, not an error: `ok: false` with `retry` (`as_is`, `check_first` or `never`).

The manifest marks the tools that only read (`unbrowse_search`, `unbrowse_logins`, `unbrowse_open`,
`unbrowse_inspect`, `unbrowse_whoami`) safe to replay and every other side-effecting, so OpenClaw never runs a write twice on
its own. Another contributor's route costs its fee, which the node pays by itself up to the owner's per-fetch maximum
and each key's daily limit; a card payment waits for the owner in their window. To keep an agent read-only, deny the
others in OpenClaw's tool policy (`tools.deny`).

## Example

```text
unbrowse_do      { "goal": "search Hacker News stories", "url": "https://hn.algolia.com/?q=rust" }
                 → { "how": "learned", "route": { "id": "hn-search", ... }, "result": { "ok": true, "data": { "hits": [...] } } }
unbrowse_do      { "goal": "search Hacker News stories", "inputs": { "q": "tauri" } }
                 → { "how": "called", ... }    the same goal again, with a new value: no browser this time
```

## Test

```bash
npm test
```

The tests run the built plugin's `register(api)` against a stub of OpenClaw's plugin API and its tools against a fake
node on loopback. They need no OpenClaw, no node and no network. They check that the plugin registers exactly the
tools `unbrowse-node/agent-api.json` lists, so a tool the node adds reaches the plugin with the SDK's next build, and
the manifest's `contracts.tools` fails the test until it names it too. The skill is a copy of `skills/unbrowse`,
written by `python3 integrations/sync-skills.py`; CI fails on a stale copy.

## Built against

- [Building plugins](https://docs.openclaw.ai/plugins/building-plugins) and
  [Tool plugins](https://docs.openclaw.ai/plugins/tool-plugins): `api.registerTool`, optional tools,
  `openclaw.extensions`, `npm-pack:` installs.
- [Plugin manifest](https://docs.openclaw.ai/plugins/manifest): `contracts.tools`, `configSchema`, `uiHints`,
  `skills`, `activation`, `reload.turnHandover`, and
  [`toolMetadata`](https://docs.openclaw.ai/plugins/manifest/capabilities) (`sideEffecting`, `replaySafe`).
- [Skills](https://docs.openclaw.ai/tools/skills) and [Skills config](https://docs.openclaw.ai/tools/skills-config):
  `metadata.openclaw.requires.env`, `primaryEnv`, `skills.entries.<name>.apiKey`.
- [Plugin dependency resolution](https://docs.openclaw.ai/plugins/dependency-resolution): plugin installs omit peers
  and skip install scripts, which is why the client is bundled.
- Source: `src/plugin-sdk/plugin-entry.ts`, `src/plugins/module-export.ts`, `src/plugins/tool-types.ts`,
  `packages/agent-core/src/types.ts` in [openclaw/openclaw](https://github.com/openclaw/openclaw) at 2026.10.8.

## Licence

[Apache-2.0](../../LICENSE).
