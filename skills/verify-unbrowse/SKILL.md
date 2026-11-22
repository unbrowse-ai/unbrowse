---
name: verify-unbrowse
description: Prove a change to the Unbrowse node (unbrowse-core) works by running it. Builds the node from this checkout, starts a scratch node on its own port and home that never touches the owner's node on 7788, checks it with a doctor, asks it for a goal on a real page the way an agent does (unbrowse_do, the agent API, MCP tools, unb, owner commands), shows its logs, and cleans up while keeping the evidence. Use before saying an Unbrowse change works, when a reviewer asks for proof, or when a site's answer must be read on a build of this branch.
---

# verify-unbrowse

`scripts/unbrowse-verify` drives a **scratch node** built from this checkout. Every command prints one JSON object,
exits 0 on success and 1 on failure with `error` and `fix` fields. `unbrowse-verify --help` and
`unbrowse-verify <command> --help` describe every flag.

```sh
V=skills/verify-unbrowse/scripts/unbrowse-verify      # from the repository root
```

What a scratch node is: `test-banks/popular-sites/scratch-node.sh` under the hood. It gets its own home
(`/tmp/ubv-<port>/home/node`), its own temp folder and none of your shell's environment. It runs headless, on a devnet
with no fork (Anvil on `<port>+1`), with telemetry, bug reports, sharing and the peer network off, and it takes a
plain bearer agent token. It never uses port 7788 or `~/.unbrowse`; the CLI refuses 7788 outright.

## Launch

1. **Build once per change** (debug, both workspaces). Point `CARGO_TARGET_DIR` at a disk with room: a debug build
   of the node and the browser program takes about 6 GB.

   ```sh
   CARGO_TARGET_DIR=/path/with/room $V build          # --dry-run prints the steps
   ```
   Every later command finds the binaries through the same `CARGO_TARGET_DIR`, so export it for the session.
2. **A page-code runtime, once.** The scratch node runs a page's signing code only in Node 25 or later, whose
   permission model denies the network. `$V runtime` finds one (`SIGNING_PROGRAM`, `node` on `PATH`) or fetches
   Node 25 from nodejs.org, checked against its `SHASUMS256.txt`, into `~/.local/state/unbrowse-verify/runtime`.
3. **Start.**

   ```sh
   $V start --port 17810                              # --dry-run prints the plan
   ```
   Ready means the script saw `/v1/health` answer and minted an agent key; `start` returns
   `"ok": true` with the pid, or `"ok": false` with the script's stderr. A Chrome is found on `PATH`, in the
   Playwright cache, or in `CHROME`; with none, the node downloads Chrome for Testing first (slower start).
   Switches of `scratch-node.sh` pass through: `--env SECOND_WALK=1`, `--env SENT_LOG=1`, `--env ONE_ASK=1`;
   `--headed` lets the browser open a window for a door that refuses headless browsers: a walk that answers
   `outcome: refused` with `why` naming a refused mint and "only a window could ask again" is that case. On Linux the
   window opens on the caller's display (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` are passed only with `--headed`).
   Clean up and start again with `--headed`; never count the headless refusal as a pass, and say which mode answered.

## Doctor

Run it first, and whenever anything looks off. Read-only.

```sh
$V doctor --port 17810
```

It passes (`"pass": true`, exit 0) only when every check holds: the node was started by this tool; the process is
alive and is the built `unbrowse-node`; the port's listener is that process; its `UNBROWSE_HOME` is the scratch home;
`/v1/health` says `alive`; `GET /v1/whoami` accepts the agent token; and the node was started at this checkout's
`HEAD`. `health.checks` shows the chain, keys and network lines; `owner_node` says the owner's node was left alone.
`ready` is reported but doesn't fail the doctor; a scratch node off the network reads `ready: true` with the chain "not needed". A `process_is_built_node`
failure ending "rebuilt since start" means the binary changed under the node: restart before trusting an answer.

## Drive

The agent is the caller (AGENTS.md, "Testing against sites"): one site at a time, one call at a time, decide the next
call from the last answer, and read the data before judging it.

```sh
# Ask for a goal on a page: the unbrowse_do primitive. Put the search term in the URL's query.
$V do --port 17810 --url 'https://hn.algolia.com/?q=rust' --goal 'search stories'
# A second value through the same route, by its input name (route.inputs in the evidence):
$V do --port 17810 --url 'https://hn.algolia.com/?q=zig' --goal 'search stories'

$V api GET /v1/whoami                                  # any agent API route, with the agent token
$V api GET '/v1/routes?q=hn'                           # unbrowse_search
$V api POST /v1/routes/<route_id>/call --body '{"inputs":{"q":"rust"}}'
$V api GET /v1/routes/<route_id>/inspect
$V mcp --list                                          # the MCP tools the node serves at /mcp
$V mcp unbrowse_whoami
$V mcp unbrowse_do --args '{"goal":"search stories","url":"https://hn.algolia.com/?q=rust"}'
$V unb -- whoami                                       # the built `unb`, pointed at the scratch node
$V node -- vault list                                  # the built `unbrowse-node`, on the scratch home
$V owner chain_status                                  # an owner command (agent-api.json's `owner[].command`)
$V owner node_info
$V logs --lines 60 --grep 'learn|route'                # node.log; --guard for refused windows and clicks
```

`do` prints `how` (`called`, `learned`, `network`, `browse`), `ok`, `route_id`, `answer` (the reply's
`result.data`), `fields_more`, `notes` (a fallback says so here) and `timings` (`wall_ms`, each round's ms, and any
`*_ms` the node reported). A learn that outlasts the node's wait answers `still_working`; `do` collects it with the
reply's `ask` handle, as an agent would, up to `--timeout` seconds.

For a learned route, read it against the engine before naming a cause:
`UB_DIR=/tmp/ubv-17810 scripts/xray/xray.sh --text` (scripts/xray/README.md).

What the log says on every scratch node and isn't a fault: `chain: Anvil isn't installed (~/.foundry/bin/anvil)`
(the node's `HOME` is the scratch one, so it finds no Foundry; the chain isn't needed off the network), `judge: the
decision model's answer was no answer, so the rule decides` (no model on a scratch node unless `MODEL_BASE` is set),
and `[own-ask] held: …` lines (the node's own extra asks, held by default).

The Feature Map, [references/features/README.md](references/features/README.md), lists every user-facing feature and
the commands that prove each one. Use it to choose what to drive for a change, and drive every entry point it lists
for that feature, not just the convenient one.

## Evidence

Every `do`, `api`, `mcp`, `owner`, `node` and `unb` call writes its request, reply and timings to
`~/.local/state/unbrowse-verify/evidence/<port>/<UTC time>-<kind>.json` and prints the path as `evidence`. Agent
tokens are never written there.

- **The real user path.** Prove a behaviour through what an agent or owner calls (`/v1/*`, `/mcp`, `unb`,
  `unbrowse-node`, `/owner/*`), never through a test-only endpoint or by editing a route file.
- **The action and the state.** Keep the `do` that learned and the `do` with a second value that called. A route
  appears under `/tmp/ubv-<port>/home/node/routes/`; `$V api GET '/v1/routes?q=<site>'` shows it.
- **Read the answer.** `ok: true` means the site answered, not that it answered the goal. Quote names, prices and
  counts from `answer` in the handback. An empty list where the page shows results is a failure.
- **Fallbacks are findings.** `browser: true` or a `notes` line on a warm call is a defect to explain, not a pass.
- **A failure is reported as it is,** with the `error` and the evidence path. Never weaken the journey to pass.

## Cleanup

```sh
$V stop --port 17810        # stops the node and the processes naming its folder (Chrome, Anvil), by pid
$V cleanup --port 17810     # stop, then remove /tmp/ubv-17810 and the record; --all for every one; --dry-run lists
```

Neither kills by process name. Both refuse a pid whose `UNBROWSE_HOME` is no longer the scratch home. Cleanup keeps
`~/.local/state/unbrowse-verify/evidence/<port>/` and says so (`evidence_still_there`). Run cleanup after every
failed attempt as well, so a broken start leaves no port or browser behind.

## Isolation

Several scratch nodes run side by side on different ports (each also takes `<port>+1` for its devnet). The CLI
refuses to start on a port anything already answers on, and never drives a node it didn't start. The owner's node
(`unbrowse-node` on 7788, `~/.unbrowse`) is never read or written; the doctor only asks its `/v1/health`.

## Maintenance

When a command, tool, screen or route changes, update its file under `references/features/`. In Claude Code, run
`/pstack:maintain-verification-skill` to check the map against the code.
