# Connect your agent

Any agent that speaks MCP or HTTP can use the node. It needs a running node and an agent key: make one in the window
(**Money**, **Add agent**) or with `unbrowse agent new <name>`, and keep the setup it prints
([your-first-call.md](../start/your-first-call.md#1-make-an-agent-key)).

**Run the agent as its own OS user, not as you.** An agent running as you can read the owner's token in
`~/.unbrowse`. `unbrowse-node agent-user install` makes the user `unbrowse-agent` with a key of its own, and
`unbrowse-node agent-user run -- <agent>` runs the agent as it ([agents-os-user.md](agents-os-user.md)).

| Endpoint | What it is |
|---|---|
| `POST http://127.0.0.1:7788/mcp` | MCP over Streamable HTTP, JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call` |
| `http://127.0.0.1:7788/v1/*` | the same primitives as HTTP |

Each request is signed with the agent's token, and the token itself never goes over the wire: the request names the
token by its key (`x-unbrowse-key`) and carries an HMAC-SHA256 keyed by the token over the method, the host and port it
is sent to, the path with its query, the body's SHA-256, the time and a fresh nonce. No client follows a redirect on a
request to the node, and a request signed for one address verifies at no other. The node takes each nonce once, across
restarts too, and never forgets one by a clock that went back: if the machine's clock is set back by more than a minute,
signed requests are refused until it passes where it was (an owner who sets it back on purpose waits that long). The
nonces the node holds are shared out by key: one agent key holds at most 20,000 at once (about 166 requests a second,
kept up), and 20,000 are only the owner's, so one agent sending as fast as it can is refused on its own and leaves the
other agents and the owner their room. A request past its key's share is refused, never let through by forgetting a
nonce still in its window. The node signs its answer
(`x-unbrowse-reply`, over the status, the body's SHA-256 and the nonce), and a client uses only an answer the node
signed. A process that took the node's address, or relays it, gets one request it can't send again and no token, and
can't hand the client an answer of its own (`unbrowse_core::signed`, `app/src/api/signed.rs`). The SDKs, `unb`,
`unb mcp`, `unbrowse mcp` and the window sign. A plain `Authorization: Bearer <token>` is refused unless the owner
allows it (below). Both surfaces are made from one list, `PRIMITIVES` in
`unbrowse-node/app/src/api.rs`, and written out as [`agent-api.json`](../../unbrowse-node/agent-api.json):

| MCP tool | HTTP | What it does |
|---|---|---|
| `unbrowse_do` | `POST /v1/do` | Say what you want with the URL of a page that does it. The node calls the route that does it, tries other nodes' routes for the site, or learns one from the page and calls that |
| `unbrowse_browse` | `POST /v1/browse` | Drive the node's browser when a page needs clicks or typing; the node learns a route from the steps. `ask_owner` hands the page to the owner |
| `unbrowse_challenge` | `POST /v1/challenge` | A page that asks for a person, as a picture: `look`, then `click`/`drag`/`type`/`press`/`wait`/`done`, each answering the page again. Your own model reads the picture |
| `unbrowse_search` | `GET /v1/routes?q=` | The routes this node knows and those other nodes list, ranked together |
| `unbrowse_call` | `POST /v1/routes/{id}/call` | Call a route by its id with new inputs |
| `unbrowse_open` | `GET /v1/open?q=` | What an `unbrowse://` link names, from the network and the chain. Calls nothing, pays nothing |
| `unbrowse_logins` | `GET /v1/logins` | The vault's logins and cards, by reference only |
| `unbrowse_whoami` | `GET /v1/whoami` | Which agent key this is, and the node it's live on |
| `unbrowse_verify_candidates` | `GET /v1/verify` | When the owner turned on Earn from routes I use: routes ranked by what verifying them pays per UNB point, less checks |
| `unbrowse_verify` | `POST /v1/verify` | Stake on a route and check it through an entry the agent picks; the agent answers for that entry |
| `unbrowse_judge` | `POST /v1/routes/{id}/judge` | Say what you saw in a route's answer: wrong for a page (the next `unbrowse_do` for it learns the page afresh), what it really is, or which fields are the answer |
| `unbrowse_report` | `POST /v1/report` | Report a problem with Unbrowse itself (wrong data, a block page answered as a success, a failed call). The node scrubs it and files it as a public GitHub issue |

What each takes and returns: [CLI.md §5](../CLI.md#5-the-agent-api-and-mcp-tools).

## Claude Code

The Claude Code plugin ([integrations/claude-code](../../integrations/claude-code)) starts `unbrowse mcp`, which
relays Claude's MCP messages to the node, each signed with the token, so Claude never sends the token. The key's setup
prints the same with `unb mcp` (the `unb` beside the node):

```sh
claude mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:7788 -- unb mcp --agent first
```

Or let `unb` do it without the token passing through a terminal: `unbrowse connect [agent index]` starts the node
if it isn't running and waits for it, takes the agent's token from `unbrowse-node agent token` (which reads the root
key wherever the node keeps it: the Keychain, or `~/.unbrowse/root.key` on a Linux machine with no keystore), checks
the agent is live on the node, and registers `unb mcp --agent first` with Claude Code, which reads the token from the grant the owner's yes
left each time Claude starts it and signs every message with it, so no command line or config holds it (`app/src/bin/unb.rs` `connect`). With no index it
connects the agent the node makes itself on its first run, so `npm i -g unbrowse && unbrowse connect` works on a fresh
machine.

On a machine the hosted Unbrowse set up, connect first shows the old entries it found and what it will do with each,
backs them up to `~/.unbrowse/migration/<time>/`, and replaces them only once the new entry has answered. An agent's
shell gets the plan and no change: run it in a terminal, or add `--yes`. `unbrowse connect --dry-run` shows the plan
alone; `unbrowse connect --undo` puts the old entries back, and `--undo --purge` also deletes the backup.

The other agents on the machine are written the same way, each in its own config file and the shape it reads, by the
app's Connect button (the first run, or the Agents screen the window opens on) or by `unbrowse connect --client
cursor,vscode,gemini-cli` (`all`: every client found here). The entry is started and asked for its tools before any file
changes; each file is kept beside itself as `<file>.before-unbrowse-<time>`; an `unbrowse` server no Unbrowse wrote is
left alone and named; a file with comments (JSONC) is left alone, since writing it back would drop them; and the
window's Undo puts every file back (`app/src/connect.rs`, `scripts/install-e2e.sh`). Connecting from the window the
first time asks the owner once, in the node's dialog, since it hands the client the first agent's grant.

### Agents the app connects

A client counts as installed by its program, never by a settings folder alone (a skills sync makes `~/.hermes/skills`
on a machine with no Hermes): its app in `/Applications` or `~/Applications`, its command on the PATH or where
installers put one (`~/.local/bin`, `~/.bun/bin`, nvm's, Homebrew's and the agents' own folders, since an app opened
from the Dock has a short PATH), or, for Cline and Roo Code, their VS Code extension. Only an installed client is
listed, and Connect writes nothing for one that isn't (`unbrowse connect --client <name>` says so). "Reopen" means it
reads its config only as it starts: quit and reopen it after connecting. Paths are a Mac's; `~/.config` is
`$XDG_CONFIG_HOME` when set.

| Client | `--client` | File | Where in it | Reopen |
|---|---|---|---|---|
| Claude Code | `claude-code` | `claude mcp add --scope user`, else `~/.claude.json` | `mcpServers`, `"type": "stdio"` | no |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` | yes |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `mcpServers` | yes |
| Codex | `codex` | `~/.codex/config.toml` (`$CODEX_HOME`) | `[mcp_servers.unbrowse]` | no |
| VS Code (GitHub Copilot) | `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `servers`, `"type": "stdio"` | yes |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | yes |
| Devin | `devin` | `~/.config/devin/mcp_config.json` | `mcpServers` | yes |
| Gemini CLI | `gemini-cli` | `~/.gemini/settings.json` | `mcpServers` | no |
| Antigravity | `antigravity` | `~/.gemini/config/mcp_config.json` | `mcpServers` | yes |
| Qwen Code | `qwen-code` | `~/.qwen/settings.json` | `mcpServers` | no |
| GitHub Copilot CLI | `copilot-cli` | `~/.copilot/mcp-config.json` | `mcpServers`, `"type": "local"`, `"tools": ["*"]` | no |
| Factory Droid | `factory-droid` | `~/.factory/mcp.json` | `mcpServers` | no |
| Kiro | `kiro` | `~/.kiro/settings/mcp.json` | `mcpServers` | no |
| Warp | `warp` | `~/.warp/.mcp.json` | `mcpServers` | yes |
| Amp | `amp` | `~/.config/amp/settings.json` | `amp.mcpServers` | no |
| opencode | `opencode` | `~/.config/opencode/opencode.json` | `mcp.servers`, `{type: "local", command: [...], environment}` | no |
| Kilo Code | `kilo-code` | `~/.config/kilo/kilo.json` | `mcp`, `{type: "local", command: [...], environment}` | no |
| Augment | `augment` | `~/.augment/settings.json` | `mcpServers` | yes |
| Junie | `junie` | `~/.junie/mcp/mcp.json` | `mcpServers` | yes |
| Cline | `cline` | `<VS Code User>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `mcpServers` | yes |
| Roo Code | `roo-code` | `<VS Code User>/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | `mcpServers` | yes |
| LM Studio | `lm-studio` | `~/.lmstudio/mcp.json` | `mcpServers` | yes |
| Hermes Agent | `hermes` | `~/.hermes/config.yaml` | `mcp_servers:` (YAML; a form it can't edit safely is left for you) | yes |
| OpenClaw | `openclaw` | `~/.openclaw/openclaw.json` | `mcp.servers` | yes |

ElizaOS is found by its `elizaos` command and listed, but it keeps its plugins in each project's character, so there is
no file of the machine's to write: add `@unbrowse/plugin-unbrowse` to the character's plugins
([integrations/elizaos](../../integrations/elizaos)).

Each entry is `unb mcp --agent first` with `UNBROWSE_NODE` in its environment, written in the client's own shape.

## ChatGPT and Claude on the web

A chat in a browser or a phone can't start a program on this machine, so it reaches the node by a URL: the node's own
remote MCP address, `https://unbrowse.ai/p/<this node's peer ID>/mcp` (`app/src/remote.rs`). The node dials out to the
gateway, so no port opens here, and only an app the owner allows gets in: the app signs in by OAuth (PKCE, dynamic
client registration), the node asks its owner in its own dialog, and a yes makes that app a remote key ($5 a day, 30
days, revocable in Settings). A sign-in asks the owner only for 10 minutes after the address is turned on or "Adding it
now? Let a sign-in ask" is pressed; any other time it is refused without a dialog.

In the window: Agents, **ChatGPT and Claude on the web**, **Turn on the address**, **Copy address** (the first run
offers the same as its second step). From a shell: `unbrowse-node remote on`, which prints the address.

- **Claude** (claude.ai, Claude Desktop, the phone app): Customize, Connectors, **+**, **Add custom connector**; name it
  Unbrowse, paste the address, Add; allow the sign-in when Unbrowse asks; turn it on in a chat's tools menu. A free plan
  can add one custom connector; on Team or Enterprise an owner adds it under Organization settings. Once added it works
  on the phone too.
- **ChatGPT** (web): chatgpt.com/plugins, **+**, **Add custom MCP server**; name and address, OAuth, tick the box,
  Create; allow the sign-in; in a new chat type `@` and pick Unbrowse. ChatGPT takes custom MCP servers on Business,
  Enterprise and Edu workspaces, added by an admin; other plans may not show the option.
- **Claude Code on another machine**: `claude mcp add --transport http unbrowse-remote <address>`.

The steps follow each app's own help pages as of November 2026; their menus move, the address and the sign-in don't.

Then give Claude Code the skill: a global npm install puts it in `~/.claude/skills/unbrowse`; otherwise
`unbrowse skill` ([the-skill.md](../reference/the-skill.md)).

## Any other MCP client

Clients the app doesn't write (Zed, whose settings are JSONC; Continue and Goose; Crush; JetBrains AI Assistant and
Cherry Studio, set up in their own settings screens) take the same stdio server by hand:
`unb mcp --agent first`, with `UNBROWSE_NODE=http://127.0.0.1:7788` in its environment. In Zed it goes under
`context_servers`; in Goose under `extensions` as `{type: stdio, cmd, args, envs}`; in Continue under `mcpServers` in
`~/.continue/config.yaml`. Hermes Agent and OpenClaw also have native plugins ([integrations/](../../integrations)), an
alternative to the MCP entry Connect writes.

Give it `unb mcp` (or `unbrowse mcp`) to start, with `UNBROWSE_AGENT_TOKEN` (and `UNBROWSE_NODE` for a node elsewhere)
in its environment: it signs each message. Codex's plugin and `integrations/codex/install.sh` set it up that way. A
framework that takes an MCP server as an object can have it from the SDK: `await node.mcpServer()` in TypeScript,
`node.mcp_server()` in Python, which give that same stdio server with the token in its environment (keep it out of
logs). An HTTP MCP client that can only send a header would send the token itself: the node refuses it unless the owner
allows bearer tokens. Where the agent takes skills, the app's first start puts the skill there for every agent it finds
on this machine (and `unbrowse install` or `unb skill` does it again; [`skills/unbrowse`](../../skills/unbrowse) is
the file itself).

## A script, or a shell

- **The SDK.** `Unbrowse` (also `UnbrowseNode`) in the `unbrowse` package, TypeScript and Python
  ([your-first-call.md](../start/your-first-call.md#4-from-your-own-code)).
- **`unb`.** `unbrowse do …`, `unbrowse browse …`, `unbrowse search …` and the rest, with the two `export` lines from
  the setup ([CLI.md §4](../CLI.md#4-unb-the-agents-shell-client)).
- **HTTP.** Sign each request as above (the SDKs' `signed.ts` and `_signed.py` are short to copy). A plain bearer
  header is refused unless the owner allows it.

Before each request the SDKs, `unb` and the window ask what answers at the node's address to prove it is the node the
token is for (`GET /v1/node/proof`). That keeps what a request says from a listener that took the port and can't reach
the node; it doesn't keep the token safe by itself (a process that relays the challenge to the node passes it), which
is why the token is never sent at all. Every request must also name the node's own host and port (`api.rs`
`own_host_only`), so a web page in a browser can't reach it by another name.

### Which agent a client acts as

An MCP entry names an agent (`unb mcp --agent <n>`, or `--agent first`), never its token. The bridge reads that agent's
grant: a file the node writes the first time the owner lets that agent's client in (`unbrowse grant <n>`, `unbrowse
connect`, or the setup line's `agent token`). While the node's root key is in the OS keystore, that first time asks the
owner in the node's dialog, naming the agent, and each agent is asked about apart, the node's first key too: a process
that has one agent's grant gets no other agent's token without the owner's yes. Revoking a key removes its grant.

An entry an older Unbrowse (12.x) wrote, such as `npx -y unbrowse mcp` or `node …/dist/cli.js mcp --account x`, names no
agent and carries no token. Run against this version it acts as the node's first agent, at `127.0.0.1:7788` unless
`UNBROWSE_NODE` says otherwise, and its old flags are ignored. It never reads the hosted sign-in in `~/.config/unbrowse`
and leaves it as it was, so going back to 12.5.0 still finds it. Until the owner lets the first agent in, the entry
still starts: it lists one tool, `unbrowse_connect`, which says to click Connect in the app or run `unbrowse connect` once
(`scripts/legacy-mcp-e2e.sh` checks both).

What remains, by design: a grant is a file of this OS user's, 0600 in `~/.unbrowse/bridges`, so any program running as
this user (an agent with a shell included) can read the grants the owner has given; it can't make a new one. A node whose
root key is kept in a plain file (`~/.unbrowse/root.key`, a Linux machine with no keystore, or a dev build) asks nothing
at all, since this user's programs read that key already. To keep an agent from other agents' keys entirely, run it as
an OS user of its own ([agents-os-user.md](agents-os-user.md)).

### Bearer tokens, for an older client

`unbrowse agent bearer on` lets the node take a token sent as a plain `Authorization: Bearer` header, from a client of a
release before signed requests (an MCP client set up with that header), and `unbrowse agent bearer off` stops it; turning
it on asks the owner first. Every node has it off, new or upgraded: an agent still set up to send a bearer token is
refused with a 401 that says what to do (run `unbrowse connect` again, which sets Claude Code up with `unb mcp`; give
another MCP client `unb mcp`; use the SDK or `unb` in a script). Turn it on only for a client that can't be changed.
What can still send a bearer token: an MCP config an earlier `unbrowse connect`, `agent new` setup or the
docs set up with an `Authorization` header, a script of the owner's that sends one, and this repository's own test
harnesses (`test-banks/popular-sites/scratch-node.sh` and the Antithesis setup write the setting on for their scratch
nodes).

## Limits on an agent

Each key has a daily limit in dollars and an expiry, which the network enforces as well as the node; the owner can
revoke it (Money, Revoke), and the revocation holds from the next day on. Agents pay from the node's own balance; paying
from your account instead is an Advanced option. The node pays another contributor's fee itself, never more for one
fetch than `max_fetch_usdc` ($0.05 by default), with nothing for the owner to approve. A card checkout and a page only a person can pass are the two things that wait for the owner
([the-app.md](../start/the-app.md#what-the-node-asks-you)). How the node keeps secrets from agents: [SECURITY.md](../../SECURITY.md#how-the-node-keeps-secrets).

Related: [Unbrowse a site](unbrowse-a-site.md) · [The agent skill](../reference/the-skill.md).
