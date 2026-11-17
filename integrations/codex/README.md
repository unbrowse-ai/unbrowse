# Unbrowse for Codex

A Codex plugin that connects Codex (the CLI, the IDE extension and the app) to the Unbrowse node on your machine. It
brings:

- the node's MCP server, as `unbrowse`: every agent tool the node serves (`unbrowse_do`, `unbrowse_browse`,
  `unbrowse_search`, `unbrowse_call`, `unbrowse_logins`, `unbrowse_judge`, `unbrowse_report` and the rest, as
  [CLI.md §5](../../docs/CLI.md#5-the-agent-api-and-mcp-tools) lists them)
- the skill `unbrowse`

It needs a running node ([docs/start/install.md](../../docs/start/install.md)) and an agent key's token. The node
needs no account and no sign-in: it joins the network with its own wallet (spec §86), and linking a wallet of yours is
optional, only for cashing out ([ONBOARDING.md](../../docs/ONBOARDING.md#2-linking-a-wallet-optional)).

## Install

Codex sends the agent token to the node from `UNBROWSE_AGENT_TOKEN`. Set it where Codex starts. The node makes its
first agent key itself on its first run, and `unbrowse agent token` prints that key's token; for a key of Codex's own,
`unbrowse agent new codex` (or the window's Money, Add agent) makes one and prints its setup once:

```sh
# Nothing to set: the plugin starts `unbrowse mcp --agent first`, which reads the first key's token from the node's
# keystore as it starts. For a key of Codex's own, `unbrowse agent new codex` shows its number: put it in place of first.
```

Then add the repository as a marketplace and install the plugin:

```sh
codex plugin marketplace add unbrowse-ai/unbrowse-core   # or ./ from a checkout
codex plugin add unbrowse@unbrowse
```

The marketplace is [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) at the repository root.
Codex reads it before the Claude Code marketplace beside it in `.claude-plugin/`.

Start a new session. `codex mcp list` (or `/mcp` in a session) shows `unbrowse`, and `/plugins` shows the plugin.

The token is never written to a file. If `UNBROWSE_AGENT_TOKEN` isn't set when Codex starts, the server doesn't start
and Codex says so. The Codex app started from the Dock doesn't read your shell profile; on macOS,
`launchctl setenv UNBROWSE_AGENT_TOKEN <token>` makes the token visible to it.

### Without the plugin

`install.sh` does the same by hand:

```sh
./integrations/codex/install.sh
```

- It adds the server to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) as `[mcp_servers.unbrowse]`, from
  [`mcp-server.toml`](mcp-server.toml). An older Unbrowse's `[mcp_servers.unbrowse]` (the 12.x `npx unbrowse mcp` or
  `dist/cli.js mcp`, or an `unbrowse.ai` address) is replaced and the file as it was is kept beside it as
  `config.toml.before-unbrowse-<time>`; every other setting stays as it was. This node's own server, and one no
  Unbrowse install wrote, are left alone. With Python 3.11 or later, the result is checked before it's written: it must
  parse, and only the `unbrowse` server may differ.
- It copies the skills into `~/.agents/skills`, where Codex reads a user's skills.
  A folder already there under a skill's name that isn't this copy is moved to `~/.agents/unbrowse-kept/`, outside
  the skills folder so Codex doesn't load it, never deleted.
- It can be run again.

Use one route, not both: the plugin and `install.sh` each bring the skills, so Codex would list them twice.

`codex mcp add unbrowse -- unbrowse mcp` adds the server alone, but passes it no token and leaves the tool timeout at
Codex's 60 seconds. Add `env_vars = ["UNBROWSE_AGENT_TOKEN"]` and `tool_timeout_sec = 330` to the table it writes.

## Configure

The server's settings:

| Key | Value | Why |
|---|---|---|
| `command`, `args` | `unbrowse`, `["mcp"]` | `unbrowse mcp` (from `npm install -g unbrowse`) relays Codex's MCP messages to the node, each signed with the token: the token never goes over the wire, and Codex never sends it, so a process that took or relays the node's port keeps nothing it can use |
| `env_vars` | `["UNBROWSE_AGENT_TOKEN"]` | The token, passed from Codex's environment to `unbrowse mcp` |
| `env` | `{ UNBROWSE_NODE = "http://127.0.0.1:7788" }` | Where the node listens |
| `startup_timeout_sec` | `20` | Codex's default is 10 |
| `tool_timeout_sec` | `330` | `unbrowse_do` can walk a page in the node's browser, which takes minutes. The SDKs wait 330 s |

A node at another address: run `install.sh` with `UNBROWSE_NODE` set (`UNBROWSE_NODE=http://127.0.0.1:9000
./install.sh`). A `[mcp_servers.unbrowse]` table in `config.toml` takes the place of the plugin's server of the same
name, so this works with the plugin installed too.

Whether Codex asks before a tool call follows its approval settings (`auto` by default). To set it for this server,
put `default_tools_approval_mode` (`auto`, `prompt`, `writes` or `approve`) in its table, or
`[mcp_servers.unbrowse.tools.<tool>] approval_mode` for one tool.

## Use

Ask for something a website does, with the page that does it:

```
search Hacker News stories about rust: https://hn.algolia.com/?q=rust
```

Codex calls `unbrowse_do`. The node calls the route that does it, or learns one from the page and calls that. When the
page needs clicks or typing, Codex drives the node's browser with `unbrowse_browse`, and the node learns a route from
those steps. The skill covers the rest: logins and cards from the vault, pages only the owner can get past
(`ask_owner`), judging a wrong answer, and failed writes. Name it with `$unbrowse` to use it on purpose.

Another contributor's route costs its fee, which the node pays by itself from its balance, up to the owner's per-fetch
maximum; nothing waits for you. The owner adds funds in the window (Money, Add funds) ([MONEY.md](../../docs/MONEY.md)).

Use the tools, not `unb` in the shell. Codex's default sandbox gives shell commands no network, so `unb` can't reach
the node; the tools are called by Codex itself.

## Files

| Path | What it is |
|---|---|
| `plugins/unbrowse/.codex-plugin/plugin.json` | The plugin's manifest |
| `plugins/unbrowse/.mcp.json` | The node's MCP server, in `config.toml`'s keys |
| `plugins/unbrowse/skills/` | The skill, copied from `skills/` at the repository root |
| `mcp-server.toml` | The same server as a `config.toml` table |
| `install.sh` | The route without the plugin |
| [`../sync-skills.py`](../sync-skills.py) | Writes the skill's copy from `skills/unbrowse` at the repository root |

The plugin carries a copy of the skill, not a link: Codex skips symlinks when it installs a plugin. Its "Connect
(once)" section is replaced with the Codex one. After changing `skills/unbrowse`, run
`python3 integrations/sync-skills.py`; CI fails on a stale copy (`integrations/check.py`). `unbrowse-map` isn't
included: it works only from a checkout of this repository.

The plugin uses Codex's own manifest (`.codex-plugin/plugin.json` with `.mcp.json`), not the portable Agent Plugins
one (`plugin.json` with `mcp.json`). The portable `mcp.json` takes only a URL and headers for an HTTP server, and drops
`Authorization`, so it can't name the token's variable or set the tool timeout.

Docs:
[MCP in Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[skills](https://learn.chatgpt.com/docs/build-skills),
[plugins](https://learn.chatgpt.com/docs/plugins),
[building plugins and marketplaces](https://developers.openai.com/plugins/build/plugins),
[sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security).
The developers.openai.com/codex pages redirect to these.

Source ([openai/codex](https://github.com/openai/codex/tree/23934d31b15b1127c83535f84854e5009f7cd51d/codex-rs) at
`23934d3`):
`config/src/mcp_types.rs` (server keys),
`codex-mcp/src/plugin_config.rs` (a plugin's `.mcp.json` read as `config.toml` keys),
`codex-mcp/src/agent_plugin_config.rs` (the portable format's limits),
`codex-mcp/src/catalog.rs` (`config.toml` wins over a plugin's server of the same name),
`core-plugins/src/marketplace.rs`, `core-plugins/src/store.rs` (symlinks skipped),
`ext/skills/src/host_roots.rs` (`~/.agents/skills`; `~/.codex/skills` is still read but deprecated),
`skills/src/metadata.rs` (`agents/openai.yaml`).

Checked with `codex-cli 0.165.0`.

## Licence

[Apache-2.0](../../LICENSE).
