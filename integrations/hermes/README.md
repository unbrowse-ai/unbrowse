# Unbrowse for Hermes Agent

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin. It gives Hermes every agent tool the
Unbrowse node serves as native tools, and the skill that says how to use them. Say what you want from a website and
get the site's own JSON back: the node calls the route that does it, or learns one from the page and calls that. Drive
the node's browser by hand when a page needs it, and the node learns a route from every step.

The tools are the [Python SDK](../../unbrowse-sdk/python)'s (`unbrowse.adapters`), written from the node's own
`agent-api.json`, so their names, descriptions and input schemas are the node's MCP server's, word for word.

## Install

The Unbrowse app runs the node. Install it and start it first (`npm install -g unbrowse`, then `unbrowse app`, or
`unbrowse start` with no window). The node needs no account and no sign-in: it joins the network with its own wallet
(spec §86), and linking a wallet of yours is optional, only for cashing out
([ONBOARDING.md](../../docs/ONBOARDING.md#2-linking-a-wallet-optional)).

The tools need the `unbrowse` Python SDK in the Python Hermes runs. It isn't on PyPI (the name there is another
project's), so install the `unbrowse-<version>-py3-none-any.whl` a
[release](https://github.com/unbrowse-ai/unbrowse-core/releases) carries, at the version of the app you run (or
the newest release). A release's wheel is what that release built and signed; the
repository's head is whatever was pushed last, so never install from it:

```bash
VERSION=13.18.1   # the release, without its v
pip install "https://github.com/unbrowse-ai/unbrowse-core/releases/download/v$VERSION/unbrowse-$VERSION-py3-none-any.whl"
```

Then install the plugin from this folder:

```bash
hermes plugins install unbrowse-ai/unbrowse-core/integrations/hermes --enable
```

Hermes asks for `UNBROWSE_AGENT_TOKEN` and saves it to `~/.hermes/.env`.

From a checkout, link the folder in instead and enable it:

```bash
ln -s "$PWD/integrations/hermes" ~/.hermes/plugins/unbrowse
hermes plugins enable unbrowse
```

Restart Hermes. `/plugins` lists `unbrowse` with its tools.

## Configure

The node makes its first agent key itself on its first run, and `unbrowse agent token` prints that key's token. For a
key of Hermes's own, `unbrowse agent new hermes` (or the window's Money, Add agent) makes one and prints its setup
once, with the node's address and the token. Put them in `~/.hermes/.env`:

```bash
UNBROWSE_AGENT_TOKEN=<token>
UNBROWSE_NODE=http://127.0.0.1:7788   # optional; this is the default
```

The tools show in the `unbrowse` toolset when the SDK is installed and `UNBROWSE_AGENT_TOKEN` is set. The node isn't
asked: when it isn't running, a call says so.

## Tools

Each tool is the node's MCP tool of the same name ([CLI.md §5](../../docs/CLI.md#5-the-agent-api-and-mcp-tools)
lists them): `unbrowse_search`, `unbrowse_do`, `unbrowse_walk`, `unbrowse_browse`, `unbrowse_challenge`,
`unbrowse_observe`, `unbrowse_logins`, `unbrowse_open`, `unbrowse_call`, `unbrowse_inspect`, `unbrowse_judge`,
`unbrowse_whoami` and `unbrowse_report`.
`unbrowse_do` says what you want (`goal`) with the `url` of a page that does it; its reply's `how` says which way it
went: `called`, `network` (another contributor's route, whose fee the node paid itself from its balance), `learned`,
or `browse` when the page needs clicks or typing. Every call of the plugin shares one browsing session, so each
`unbrowse_browse` step acts on the page the last one opened.

Every tool answers a JSON string: the node's JSON in its own field names, or `{"error": <the node's reason>, "code":
...}` when the node refuses or can't be reached, with the codes the SDK's `UnbrowseError` uses (`not_found`,
`unauthorized`, `unavailable`, `unreachable`, ...). A call that reached the site and didn't pass is a result, not an
error: `ok: false` with `retry` (`as_is`, `check_first`, `never`), which the model reads before sending a write again.

Money works as it does everywhere else: another contributor's route costs its fee, which the node pays by itself up to
the owner's per-fetch maximum and the key's daily limit, and a card payment waits for the owner in their window.

## The skill

The plugin registers the skill as `unbrowse:unbrowse` ([skills/unbrowse/SKILL.md](skills/unbrowse/SKILL.md)): a copy
of the repository's [`skills/unbrowse`](../../skills/unbrowse/SKILL.md) with a Connect section for Hermes, written by
`python3 integrations/sync-skills.py` (CI fails on a stale copy). Hermes lists it while the plugin is enabled, and the
agent loads it with `skill_view("unbrowse:unbrowse")`.

## Example

> Find the top Hacker News stories about Rust.

Hermes calls:

```json
{"name": "unbrowse_do", "arguments": {"goal": "search Hacker News stories", "url": "https://hn.algolia.com/?q=rust"}}
```

The first time, the node walks the page and answers `{"how": "learned", "route": {"id": ..., "inputs": [{"name": "q", ...}]}, "result": {"ok": true, "data": {...}}}`.
The next time, with the same goal and `"inputs": {"q": "tauri"}`, it answers `"how": "called"` in a few hundred
milliseconds, with no browser.

## Without the plugin: MCP

Hermes can also reach the node as an MCP server. Add it to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  unbrowse:
    command: "unbrowse"
    args: ["mcp", "--agent", "first"]   # the key's number, or first; let it in once with `unbrowse grant first`
    env:
      UNBROWSE_NODE: "http://127.0.0.1:7788"
    timeout: 330   # unbrowse_do may walk a page, which can take minutes
```

`unbrowse mcp` (from `npm install -g unbrowse`) relays Hermes's MCP messages to the node, each signed with the token: the token
never goes over the wire, so a process that took or relays the node's port keeps nothing it can use. It reads the
token of the key it names (`--agent`) from the grant the owner gave it once (`unbrowse grant`), so the config holds
no token. The tools then
show as `mcp__unbrowse__unbrowse_do` and so on. The skill isn't included this way; copy the repository's
[skills/unbrowse](../../skills/unbrowse) into `~/.hermes/skills/` if you want it.

## Tests

```bash
cd integrations/hermes
python3 -m unittest discover -s tests
```

They run offline against a fake node and a stub of Hermes's plugin context, with the SDK from this checkout. Neither
Hermes nor a node is needed, and CI runs them. They check that the plugin registers exactly the tools
`unbrowse-node/agent-api.json` lists, with the node's words: a tool the node adds comes with the SDK, and the tests fail
until `TOOL_NAMES` in `tools.py` and `provides_tools` in `plugin.yaml` name it too.

With Hermes installed, `hermes plugins validate integrations/hermes` and `hermes plugins doctor integrations/hermes`
run Hermes's own checks.

## References

- Building a plugin (manifest, `register(ctx)`, `register_tool`, `register_skill`, `requires_env`, Python dependencies):
  https://hermes-agent.nousresearch.com/docs/developer-guide/plugins
- Installing and enabling plugins: https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
- Skill format (`SKILL.md`, `metadata.hermes`): https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills
- MCP servers in `config.yaml`: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- Source: [`hermes_cli/plugins.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/plugins.py)
  (`PluginContext.register_tool`), [`hermes_cli/plugins_content.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/plugins_content.py)
  (`register_skill`), [`tools/registry.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/registry.py)
  (schemas, `check_fn`, dispatch).

## Licence

[Apache-2.0](../../LICENSE).
