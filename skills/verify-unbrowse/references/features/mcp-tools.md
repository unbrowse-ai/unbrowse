# MCP tools

The node is an MCP server at `POST /mcp` (Streamable HTTP, JSON-RPC). Every agent primitive is one tool, made from the same list as the HTTP route and running the same code. An agent client sees the tool names, descriptions and input schemas, calls a tool, and gets the same JSON as the HTTP route. `unb mcp` is the stdio bridge that signs each message for clients that cannot.

## Sub-features

- `mcp-initialize-ping` answers `initialize` and `ping`.
- `mcp-tools-list` lists the tools in `unbrowse-node/agent-api.json`: `unbrowse_search`, `unbrowse_do`, `unbrowse_walk`, `unbrowse_browse`, `unbrowse_challenge`, `unbrowse_observe`, `unbrowse_logins`, `unbrowse_open`, `unbrowse_call`, `unbrowse_inspect`, `unbrowse_judge`, `unbrowse_whoami`, `unbrowse_report`.
- `mcp-same-as-http` returns the same shape as the matching HTTP route.
- `mcp-renamed-args` takes `query` for search, `route_id` for call, inspect and judge, `link` for open.
- `mcp-required-args` refuses a call missing a required argument.
- `mcp-unknown-tool` refuses a tool name that is not listed.
- `mcp-read-only-tools` runs `unbrowse_whoami`, `unbrowse_logins`, `unbrowse_search`, `unbrowse_open`, `unbrowse_inspect`, `unbrowse_observe` with no spend and no change.
- `mcp-bridge` signs stdio messages with `unb mcp`.

## How to get to it (user POV)

- Add the server to a client: `claude mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:7788 -- unb mcp --agent first`. Do this only for a real owner, never for the scratch node by hand.
- Send JSON-RPC `initialize`, `ping`, `tools/list` and `tools/call` to `POST /mcp` with the agent's token.
- Run `unb mcp [--agent <index|first>]` as the stdio bridge.
- In the SDK, call `node.mcpServer()` (TypeScript) for the bridge config.
- Agent frameworks get the same tools from `unbrowse/ai-sdk`, `unbrowse/langchain`, `unbrowse/mastra`, `unbrowse/openai-agents` and `unbrowse/tools`.

## Driving it with unbrowse-verify

Preconditions:

- A scratch node is healthy and `unbrowse-verify doctor` passes.
- For the call recipes, one route exists (see `routes.md`). Note its `route_id`.

- **List.** Run `unbrowse-verify mcp --list`. The 13 tools in the manifest are listed, each with a description and an input schema. Compare the names against `unbrowse-node/agent-api.json`.
- **Identity.** Run `unbrowse-verify mcp unbrowse_whoami --args '{}'`. It names the agent, its address, the node and the browser state. Compare with `unbrowse-verify api GET /v1/whoami`.
- **Logins by reference.** Run `unbrowse-verify mcp unbrowse_logins --args '{}'`. Logins and cards are references only. No password, code or full number.
- **Search.** Run `unbrowse-verify mcp unbrowse_search --args '{"query":"hn"}'`. It lists the same routes as `api GET '/v1/routes?q=hn'`.
- **Do.** Run `unbrowse-verify mcp unbrowse_do --args '{"goal":"search Hacker News stories","url":"https://hn.algolia.com/?q=rust"}'`. `how` is `called` or `learned`, with the same fields as `unbrowse-verify do`.
- **Call.** Run `unbrowse-verify mcp unbrowse_call --args '{"route_id":"<id>","inputs":{"q":"rust"}}'`. The answer matches the HTTP call.
- **Inspect and judge.** Run `unbrowse-verify mcp unbrowse_inspect --args '{"route_id":"<id>"}'`, then `unbrowse-verify mcp unbrowse_judge --args '{"route_id":"<id>","verdict":"right"}'`. Each matches its HTTP route.
- **Link.** Run `unbrowse-verify mcp unbrowse_open --args '{"link":"unbrowse://example.com"}'`. Routes are listed and nothing is paid.
- **Missing argument.** Run `unbrowse-verify mcp unbrowse_call --args '{}'`. The reply is an error naming `route_id`, not a crash.
- **Unknown tool.** Run `unbrowse-verify mcp unbrowse_nothing --args '{}'`. The reply is an error that the tool is unknown.
- **Parity.** Run `unbrowse-verify mcp unbrowse_search --args '{"query":"hn"}'` and `unbrowse-verify api GET '/v1/routes?q=hn'`. The two evidence files hold the same routes.

## Gotchas

- Every `unbrowse-verify mcp` call sends `initialize` first and fails with its HTTP status if the node refuses it, so a passing `mcp --list` proves `initialize` too. `ping` is not sent: report it as not proven through the harness.
- The tool count in older docs (`unbrowse-node/README.md`) says seven. The manifest says 13. Trust `agent-api.json` and the live `--list`.
- `unb mcp` needs a grant (`unb grant`) that asks the owner once, or `UNBROWSE_AGENT_TOKEN`. The scratch node has no owner to ask. Report the bridge as not proven unless the token path works.
- A request with no token, or the wrong key, gets 401. The harness always sends a token, so this is not driven here.
- Tool arguments use the renamed names (`query`, `route_id`, `link`). The HTTP routes use `q` and `{id}`. A mix-up fails in a way that looks like a bug.
- The browse, challenge and observe tools need a page open in the node's browser. On the scratch node they work only after a `how: browse` or a `walk`. Without one they say so.
- Do not call `unbrowse_report` here. See `telemetry.md`.
- Never put a card or password into a tool argument. Use `vault:` references.
