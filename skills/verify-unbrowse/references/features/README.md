# Unbrowse node verification map

This directory is the maintained source for verifying the user-facing behavior of the Unbrowse node. Read this index before driving anything, then use the matching feature file as the recipe. The design source is `AGENTS.md` and `CLAUDE.md` in the repository root. A fix or a check is stated as a property of the walk, never as a site's name. Sites appear here only as example URLs.

## Baseline preconditions

- Build from the checkout first: `unbrowse-verify build`. It builds `unbrowse-node`, `unb` and `agent-browser` (debug).
- Start a scratch node: `unbrowse-verify start --port 17810`. It runs on its own home under `/tmp/ubv-17810`, headless, on the devnet with no fork, with telemetry, bug reports, the peer network and sharing off, and one agent bearer token.
- Never use port 7788. That is the owner's node. Never drive a node this run did not start.
- Run `unbrowse-verify doctor --port 17810`. Require `pass: true` (`ready` is read but does not fail it; the doctor needs `alive`) and the scratch home, port and build revision you expect.
- A page whose signing code runs in the sandbox needs Node 25 or later. Run `unbrowse-verify runtime` once; without it such a route goes to the browser or fails, and the learn says why.
- A learn needs the built browser and a live site. If either is missing, report the missing precondition. Do not substitute a canned answer.
- The scratch node cannot show a window, hold a real wallet, reach a live chain, meet a peer, or get the owner's yes (passphrase and confirm dialogs). Each feature file says what that means for its journeys.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Run agent calls through `unbrowse-verify do`, `api`, `mcp`. Run owner calls through `unbrowse-verify owner`. Run terminal commands through `unbrowse-verify node -- <args>` and `unbrowse-verify unb -- <args>`.
- Treat every command as literal. Keep quoted goals, flags and JSON unchanged.
- Never run a first word `unbrowse-node` does not know. It starts a node instead of printing usage. `agent` without `new` does the same.
- Never run `unbrowse start`, `unbrowse app`, `unbrowse restart`, `unbrowse update`, `unb connect` or `unbrowse skill` without a scratch target. They act on the owner's node or on the owner's agent config.
- Use a goal in plain words and a URL whose query carries the value (`https://hn.algolia.com/?q=rust`). The same goal words find the same route.
- Ask for the same goal twice with two different values. A second value must change the answer.
- Remove what a recipe adds (logins, cards, agent keys, routes) at its end. Keep the evidence.

## Proof and skip reporting

- Every `do`, `api`, `mcp` and `owner` call writes its request and reply to the evidence directory and prints the path. Cite that path.
- For a learn or a call, record `how`, `route_id`, `timings.wall_ms`, the answer, and `notes`. `ok: true` means the site answered, not that it answered the goal. Read the answer against the goal.
- A warm call (`how: called`) that used the browser, or carries a fallback in `notes`, is a defect to report. It is not a pass.
- A check that did not run is not a pass. Write the line that says which check and why.
- For a mutation, read the stored value back through a second view (`vault list`, `owner routes`, `owner settings`).
- Redact tokens, cookie values, card numbers and passwords before they reach a report. References such as `vault:<site>:<account>` are fine.
- Record the feature ID and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with unbrowse-verify` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run, and what a scratch node cannot prove.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, tool and route names, and file paths a verifier reads as evidence.

## Features

- [CLI](./cli.md) covers the `unbrowse-node` owner commands, the installed `unbrowse` command and the `unb` shell client.
- [MCP tools](./mcp-tools.md) covers the agent primitives as MCP tools at `POST /mcp`.
- [Routes: learn and call](./routes.md) covers `do`, `search`, `call`, `inspect`, `judge`, `walk`, `browse`, `observe`, `challenge` and the route files on disk.
- [SDK](./sdk.md) covers the `unbrowse` TypeScript and Python clients, the owner client and the agent-framework adapters.
- [Window](./window.md) covers the native window screens and the owner data behind them.
- [Vault and payments](./vault-and-payments.md) covers logins, cards, passkeys, sessions, the wallet, the devnet chain, coins, bounties, max-fetch and checkout approval.
- [Telemetry and bug reports](./telemetry.md) covers telemetry, bug reports and `unbrowse_report`.
