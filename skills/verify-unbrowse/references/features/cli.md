# CLI

Three programs give a person or a script a terminal route into the node. `unbrowse-node` is the node itself and the owner's command line: with no command it starts the node, and with a command it reads or changes the owner's state. `unb` is the agents' shell client for the agent API. `unbrowse` is the command npm and PyPI install: it opens the window, passes owner commands to `unbrowse-node` and everything else to `unb`. Exit code 0 is done, 1 is failed with the reason on stderr, 2 is a usage error with the usage line on stderr.

## Sub-features

- `cli-usage-error` prints a usage line and exits 2 for an unknown subcommand.
- `cli-chain` shows the chain and its contracts without reading the chain.
- `cli-agent-key` makes an agent key, prints its setup once, and reads its token.
- `cli-agent-bearer` shows whether a plain bearer token is taken.
- `cli-readouts` prints state with no secret: `terms`, `network`, `share`, `session list`, `browser`, `update channel`, `max-fetch`.
- `cli-money-readouts` prints `wallet`, `wallet address`, `money`, `earnings`, `nodes`.
- `cli-running-node` says "start the node first" for a running-node command when none runs.
- `unb-whoami` and `unb-logins` read the agent's identity and the vault by reference.
- `unb-search-do-call` map to `GET /v1/routes`, `POST /v1/do`, `POST /v1/routes/{id}/call`.
- `unb-inspect-walk-observe` map to the inspect, walk and observe routes.
- `unb-open` previews an `unbrowse://` link and calls nothing.
- `unb-refuses-secret-argument` refuses `challenge type --text <words>` with exit 2.
- `unbrowse-where` shows where the installed programs are.

## How to get to it (user POV)

- Run `unbrowse-node <command>` for the owner commands in `docs/CLI.md` section 2: `agent`, `chain`, `bounty`, `coin`, `domain`, `max-fetch`, `network`, `browser`, `update`, `restart`, `agent-user`, `passphrase`, `confirm`, `checkout`, `passkey`, `session`, `reports`, `share`, `sign-in`, `telemetry`, `terms`, `vault`, `wallet`, `nodes`, `money`, `earnings`.
- Run `unb <command>` with `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN` set: `do`, `search`, `call`, `browse`, `challenge`, `open`, `logins`, `whoami`, `judge`, `report`, `inspect`, `walk`, `observe`, `connect`, `grant`, `mcp`.
- Run the installed `unbrowse <command>`: `app`, `start`, `skill [dir]`, `where`, any node command, else any `unb` command.
- The window's own entry points are in `window.md`.

## Driving it with unbrowse-verify

Preconditions:

- A scratch node answers on the port under test. `unbrowse-verify doctor` reports `pass: true`.
- Commands that say "running node" need that node. The scratch home holds its owner token, so `unbrowse-verify node --` finds it.

- **Usage error.** Give a command a subcommand it does not know. Run `unbrowse-verify node -- vault bogus`. The usage line is on stderr and the exit code is 2.
- **Chain readout.** Run `unbrowse-verify node -- chain`. It names `devnet`, a chain ID and an RPC, and says whether Settlement is deployed. It reads no chain.
- **Terms.** Run `unbrowse-verify node -- terms`. It prints the terms version and whether it is acknowledged and whether the node joins the peer network. On the scratch node it does not join.
- **Network and share.** Run `unbrowse-verify node -- network` then `unbrowse-verify node -- share status`. The first says `off`. The second shows the mode and today's listings against the cap, with no route listed.
- **Per-fetch maximum.** Run `unbrowse-verify node -- max-fetch`. It prints 0.05 USDC unless set. Run `unbrowse-verify node -- max-fetch 0.1`, read it back with `max-fetch`, then restore 0.05.
- **Agent key.** Run `unbrowse-verify node -- agent new verify-key 1 1`. It prints a setup that names the agent by its number and holds no token. Then run `unbrowse-verify node -- agent token 1` and confirm one token alone on a line. Redact it.
- **Bearer state.** Run `unbrowse-verify node -- agent bearer`. The scratch node reports it on, as its start script sets.
- **Running-node message.** Run `unbrowse-verify stop`, then `unbrowse-verify node -- restart`. It says no node runs and does nothing else. Run `unbrowse-verify start` again.
- **Shell client reads.** Run `unbrowse-verify unb -- whoami` and `unbrowse-verify unb -- logins`. The first prints the agent's name, address and the node's browser state. The second prints logins and cards by reference, no secret.
- **Shell client search and inspect.** After a route exists, run `unbrowse-verify unb -- search hn` then `unbrowse-verify unb -- inspect <route id>`. The route is listed, then its steps, fields and sources are shown.
- **Preview a link.** Run `unbrowse-verify unb -- open unbrowse://example.com`. It prints the site's routes and calls nothing.
- **Secret on the command line.** Run `unbrowse-verify unb -- challenge type --text abc`. It exits 2 before anything is sent.
- **Installed command.** If `unbrowse` is on `PATH`, run `unbrowse where`. It names where the programs are. This is read-only.

## Gotchas

- A first word the node does not know starts a node. So does `agent` without `new`. Never type a guess.
- `unbrowse start`, `unbrowse app`, `unbrowse restart` and `unbrowse update` act on the owner's node on 7788. Do not run them. The installed `unbrowse` command cannot be pointed at the scratch node by the harness. Report it as not proven when it is not installed.
- `unb connect` rewrites the owner's Claude Code and other agent config. `unb grant` and `unb mcp --agent` need the owner's yes the first time. `unbrowse skill` writes into `~/.claude/skills`. None of these is driven here.
- `passphrase`, `confirm`, `sign-in`, `wallet restore`, `wallet import`, `wallet export` and `agent cap` need a terminal, a dialog or the owner's yes. The scratch node has no screen and no owner. The honest outcome is "not proven: the owner's yes cannot be given". Do not weaken the journey.
- `agent-user install` needs the machine's admin and makes an OS user. Never run it.
- `agent token` asks the owner in a dialog when the root key is in the OS keystore. The scratch home is not that case, but if it asks, report it.
- `update`, `browser install` and `chain deploy` reach out or change the build. Do not run them. `browser` (status) and `update channel` (read) are safe.
- A command that needs stdin (`vault add --stored`, `vault card add`, `wallet restore`) may not pass stdin through `unbrowse-verify node --`. If it does not, report the path as unreachable.
- Agent tokens print once in plain text. Never leave one in evidence.
