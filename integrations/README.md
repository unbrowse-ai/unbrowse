# Integrations

The Unbrowse node as a native plugin for each agent. Every one gives the agent every tool the node's MCP server
serves (`unbrowse_do`, `unbrowse_browse`, `unbrowse_search`, `unbrowse_call`, `unbrowse_logins`, `unbrowse_judge`,
`unbrowse_report` and the rest, [CLI.md §5](../docs/CLI.md#5-the-agent-api-and-mcp-tools)) with the node's own
descriptions, and the [`unbrowse`](../skills/unbrowse/SKILL.md) skill where the agent takes skills. Each reads the same
two values: the node's address (`UNBROWSE_NODE`, default `http://127.0.0.1:7788`) and an agent key's token
(`UNBROWSE_AGENT_TOKEN`).

The node needs no account and no sign-in: it joins the network with its own wallet (spec §86), and linking a wallet
of yours is optional, only for cashing out or several nodes sharing a deposit
([ONBOARDING.md](../docs/ONBOARDING.md#2-linking-a-wallet-optional)). It makes its first agent key itself on its first
run: `unbrowse agent token` prints that key's token, and `unbrowse agent new <name>` (or the window's Money, Add agent)
makes another and prints its setup once.

| Agent | Directory | What it is | Install |
|---|---|---|---|
| Claude Code | [`claude-code/`](claude-code) | Plugin: the node's MCP server and the skill; asks for the token when enabled | `/plugin marketplace add unbrowse-ai/unbrowse-core`, then `/plugin install unbrowse@unbrowse` (or, without the plugin, `unbrowse connect`) |
| Codex | [`codex/`](codex) | Plugin: the node's MCP server and the skill, or `install.sh` for `config.toml` | `codex plugin marketplace add unbrowse-ai/unbrowse-core`, then `codex plugin add unbrowse@unbrowse` |
| OpenClaw | [`openclaw/`](openclaw) | Plugin: the node's tools as native agent tools, and the skill | `openclaw plugins install npm:@unbrowse/openclaw-plugin --accept-capabilities` (once published; [README](openclaw/README.md) installs it from here) |
| Hermes Agent | [`hermes/`](hermes) | Plugin: the node's tools in an `unbrowse` toolset, and the skill | `hermes plugins install unbrowse-ai/unbrowse-core/integrations/hermes --enable`, with the Python SDK ([README](hermes/README.md)) |
| ElizaOS | [`elizaos/`](elizaos) | Plugin: a service, an action for each of the node's tools, and two providers | [README](elizaos/README.md) |

The marketplaces live at the repository root: [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
for Claude Code and [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json) for Codex, which reads
its own before Claude Code's.

## Keeping them in step

- **Tool words.** Claude Code and Codex use the node's MCP server, so they list whatever the node serves. OpenClaw,
  Hermes and ElizaOS build their tools from the SDK's generated tool layer (`unbrowse/tools` in TypeScript,
  `unbrowse.adapters` in Python), which `unbrowse-sdk/codegen/generate.py` writes from
  [`unbrowse-node/agent-api.json`](../unbrowse-node/agent-api.json). Nothing here copies the node's words by hand. The
  names each plugin declares up front (OpenClaw's `contracts.tools`, Hermes's `provides_tools` and `TOOL_NAMES`) are
  checked against `agent-api.json`, so a tool the node adds fails CI until they name it.
- **The skill.** Claude Code links `skills/unbrowse`. Codex, OpenClaw and Hermes carry copies, because each skips or
  can't follow a link when it installs a plugin. After changing `skills/unbrowse`, run
  `python3 integrations/sync-skills.py` and commit what it writes; CI fails on a stale copy.
- **The SDK.** OpenClaw, Hermes and ElizaOS call the node through the `unbrowse` SDK ([unbrowse-sdk/](../unbrowse-sdk)).
  The SDK this repository builds isn't on npm or PyPI yet (npm serves an older `unbrowse`, and the name on PyPI is
  another project's), so until it is, they build against the copy in this repository: OpenClaw bundles it into its
  build, and the Hermes and ElizaOS READMEs say how to install it.

## Tests

```sh
python3 integrations/check.py                                   # CI: manifests, paths, links, tool lists, skill copies
(cd integrations/hermes && python3 -m unittest discover -s tests) # CI
(cd unbrowse-sdk/typescript && npm ci && npm run build)          # the SDK, which the next two build against
(cd integrations/openclaw && npm install && npm test)
(cd integrations/elizaos && npm install && npm test)
claude plugin validate . && claude plugin validate ./integrations/claude-code
```

None needs a running node: each runs against a fake one on the agent API's paths.

## Licence

[Apache-2.0](../LICENSE).
