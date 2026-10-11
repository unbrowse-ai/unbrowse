# CLI reference

`unbrowse <command> [args] [--json] [--base-url URL] [--no-open]`

A thin shell over the REST API (`/api/v1`, see [api.md](api.md)). Output is JSON on stdout;
messages go to stderr. Agents that need the cloud browser use the hosted MCP ([mcp.md](mcp.md)).

## Account

| Command | Route |
|---|---|
| `login` | Browser sign-in: OAuth 2.1 with PKCE and a loopback redirect. The token's resource is `{origin}/api` (this REST API), not `/mcp` |
| `login --key ub_live_…` | Stores an API key (create one in the console, MCP & keys) |
| `logout` | Deletes the stored sign-in |
| `whoami` | `GET /me` |
| `usage` | `GET /usage` |

Credentials are read in this order: `UNBROWSE_API_KEY`, the stored key, the stored OAuth token
(refreshed when it is about to expire). Stored at `~/.config/unbrowse/cli.json`, mode 0600.

First use: a command that needs an account (`run`, `discover`, `whoami`, …), run at a terminal with
no credential, starts the same browser sign-in as `login` and then carries on. Without a terminal
(no TTY, `CI` set, or `--json`) it exits 3 and names `unbrowse login` and `UNBROWSE_API_KEY`.

## Runs

| Command | Route |
|---|---|
| `discover <query>` | `POST /capabilities/search` |
| `run <task…>` | `POST /runs`, then `GET /runs/:id` until it settles |
| `inspect <runId>` | `GET /runs/:id` |
| `resume <runId> field=value…` | `GET /runs/:id`, then `POST /runs/:id/responses` |
| `cancel <runId>` | `POST /runs/:id/cancel` |

`run` options: `--capability ID` (run a known capability), `--url URL`, `--set key=value`
(repeatable) and `--input JSON` for inputs, `--unattended` (never pause for input),
`--idempotency-key K` (one is generated otherwise), `--no-wait`, `--timeout S` (default 600).

Site requests go from this machine (your IP) by default: the run's HTTP calls to the site are
handed to the CLI (`POST /runs` with `egress: "client"`, answered through `/egress/:id`), each noted
on stderr. Unbrowse's own services never go through your machine. `--from-unbrowse` (or
`UNBROWSE_EGRESS=server`) sends them from Unbrowse instead.

Values are typed: `adults=2` is a number, `flex=true` a boolean, `x='{"a":1}'` JSON, anything
else a string. `resume` names requirements by field (`origin=CDG`) and answers on the same run.

The printed run leaves out its event log (as MCP does); `--events` keeps it. When nothing fits
(`no_capability`) the next steps are printed on stderr as CLI commands: `scrape` the page, `index`
the site, or a near-match `--capability`.

## Pages

| Command | Route |
|---|---|
| `scrape <url>` | `POST /scrape` |

The page's main content as markdown on stdout, so it pipes; title, final URL and HTTP status on
stderr. `--format markdown,links` (any of `markdown`, `html`, `text`, `links`, `raw`), `--full`
(keep navigation and footers), `--render auto|always|never`, `--country GB`, `--deadline MS`.
`--json` prints the whole answer with its metadata. One verified call.

## Teaching

| Command | Route |
|---|---|
| `index <url> [--focus T] [--max N]` | `POST /index`, then `GET /index/:id` until it ends |
| `index status [jobId]` | `GET /index/:id`, or `GET /index` for all |
| `learn a.har b.har [--title T] [--goal G]` | `POST /learn` |
| `learned [id]` | `GET /learned`, `GET /learned/:id` |

`index` has an agent explore the site in Unbrowse's cloud browser and compile each flow it can
prove into a tool. It takes minutes; progress goes to stderr, Ctrl-C leaves the job running, and
`--no-wait` returns the job id at once. Done means `status: done` with `indexed` above 0; then
`unbrowse site <host>` lists the tools.

Record the task twice with different inputs (a HAR export from devtools) and pass both. Doing a
task in the cloud browser is an MCP flow (`unbrowse_browse_*`), not a CLI command.

## Logins

| Command | Route |
|---|---|
| `logins` | `GET /logins` — masked hints, never values |
| `logins remove <origin>` | `POST /logins/remove` |

The CLI never takes a password. When a run needs a login nobody saved, it opens the one-time
save-login page and exits 3. See [logins-and-vault.md](logins-and-vault.md).

## Cookies — reuse your browser's sessions

Sign in to a site in your normal browser, then hand those cookies to Unbrowse so your runs act as
your signed-in self. The cookies are read locally (decrypted with your OS keychain where the browser
encrypts them), sent to Unbrowse, and kept per site — sealed in your vault, so the session persists.

| Command | What it does |
|---|---|
| `cookies list` | Browsers and profiles found on this machine. `--json` for an agent to choose from. |
| `cookies sync` | Read cookies and upload them once (`POST /cookies`). |
| `cookies watch` | Keep the chosen sites in sync in the foreground: re-read every interval, upload a site when its cookies change (and at least daily). |
| `cookies daemon start` | The same as a background service that survives logouts and reboots (systemd user unit on Linux, LaunchAgent on macOS). |
| `cookies daemon status` | Running or not, the sites, the last sync and the last error. `--json` for an agent. |
| `cookies daemon stop` | Stop and remove the service, its config and state. |

```sh
unbrowse cookies list
unbrowse cookies sync --domain github.com        # just one site
unbrowse cookies sync --browser Chrome --profile Default
unbrowse cookies sync --all                      # every profile found
```

Options: `--browser NAME`, `--profile NAME` (from `cookies list`), `--domain d` (one site and its
subdomains), `--all` (every profile; otherwise the default profile is used). Supported: Chrome,
Chromium, Arc, Brave, Edge, Opera, Vivaldi, Firefox, LibreWolf, Waterfox, on macOS, Linux and
Windows. Cookies a browser encrypts with a locked keyring, or a sandboxed (Flatpak/Snap) install
whose key is not reachable, are reported and skipped. Everything is read locally; only the cookies
you sync leave your machine. Reads work best with the browser closed.

### Keep sites in sync continuously

```sh
unbrowse cookies daemon start --domain github.com,linkedin.com   # named sites; asks to confirm, --yes in scripts
unbrowse cookies daemon start --all-sites                        # EVERY site you are signed into (incl. banking/email): confirm carefully
unbrowse cookies daemon status
unbrowse cookies daemon stop
```

The daemon syncs the sites you name — or every site in the profile with `--all-sites` (uploaded in batches, grouped by registrable site; new sites you sign into are picked up on their own). It reads from one browser profile (`--browser`, `--profile`; else the
default profile), every `--interval` minutes (default 15). A site is uploaded when its cookies change, and
at least once a day so the kept session never ages out; expired cookies are never sent. `start` first runs
one sync and refuses to start if it cannot read the browser or reach Unbrowse. Failures back off (doubling,
up to an hour) and show in `status`; a sign-out from Unbrowse says to run `unbrowse login`. The service runs
the installed CLI (`npm i -g unbrowse` first: a temporary `npx` copy is refused). Logs: `journalctl --user -u
unbrowse-cookies -f` (Linux), `~/Library/Logs/unbrowse-cookies.log` (macOS). Windows: run `unbrowse cookies
watch` from Task Scheduler at logon.

After `unbrowse login` at a terminal, the CLI offers this once: name the sites (or press Enter to skip).
Nothing is synced unless you name a site; scripts and agents (no terminal, `--json`) are never asked.

## Public registry (no account)

| Command | Route |
|---|---|
| `registry [query]` | `GET /sites?q=` |
| `site <host>` | `GET /sites/:host` |
| `openapi <host>` | `GET /sites/:host/openapi.json`: OpenAPI 3.1, one operation per tool |

## Call one site tool

| Command | Route |
|---|---|
| `call <host> <tool> [JSON]` | `POST /sites/:host/call/:tool` with the tool's inputs as the body |

Inputs as a JSON argument, `--input JSON` or `--set key=value` (repeatable). `--deadline MS`, `--select PATH,…` (narrow the result), `--idempotency-key K`, `--end-user ID` (org keys). Prints the run; needs an account.

## Your agents' MCP servers

| Command | Route |
|---|---|
| `mcps` | None: reads this machine's agent configs. No account needed |
| `mcps import [name…]` | `POST /connectors/import`; with `--with-keys`, `POST /connectors/connect` for each server that has a key |

`mcps` lists the MCP servers configured in Claude Code (`~/.claude.json`, the project's `.mcp.json`), Claude Desktop,
Cursor (`~/.cursor/mcp.json`, `.cursor/mcp.json`), Codex (`~/.codex/config.toml`), VS Code (`mcp.json`), Windsurf,
Gemini and Zed. Headers and env vars are shown by name; values are never printed, and arguments that look like keys
show as `‹hidden›`. `--json` for agents.

`mcps import` brings them into Unbrowse, so their tools run there with your own account and every agent signed in
to Unbrowse gets them. Remote servers connect by address: open ones at once, OAuth ones return the sign-in link.
A local bridge (`mcp-remote`, `supergateway`) imports the address it forwards to. A local (stdio) server cannot run in
Unbrowse's cloud: when the catalog has the same app hosted (`@modelcontextprotocol/server-github` → GitHub), that is
connected instead; otherwise it is reported `local_only` and stays in your agent. Unbrowse itself, duplicates across
agents and servers already connected are skipped. `--dry-run` shows the plan and connects nothing.

Only names, addresses and package names are sent. A key in a config stays on this machine unless you add
`--with-keys`: then the key of each remote server that has one (an `Authorization` or api-key header with a value,
not a `${VAR}` reference) is sent to Unbrowse and sealed in your vault. It asks first; scripts pass `--yes`.
Exit 1 when any server failed.

## Local MCP proxy

`unbrowse mcp` serves MCP over stdio and forwards every call to the hosted MCP (`<origin>/api/mcp`, or `--url` / `UNBROWSE_MCP_URL`) with the CLI's credentials: `UNBROWSE_API_KEY`, `login --key`, or the `login` OAuth token, refreshed per call. The hosted tools are already named `unbrowse_x`; any other name with a character outside `[A-Za-z0-9_-]` is rewritten for hosts such as Grok Build and mapped back on each call. `--end-user ID` (or `UNBROWSE_END_USER`) sends `X-Unbrowse-End-User` for org keys. Nothing but protocol goes to stdout. `--from-here` (or `UNBROWSE_EGRESS=client`) runs `unbrowse_run` the way `unbrowse run` does: its site requests go from this machine, with its IP, each noted on stderr. Use it where the agent has its own computer, such as a Grok Bot (`npx -y unbrowse mcp --from-here` as a custom stdio server). Every other tool, and `unbrowse_resume` on that run, still goes through the hosted server; `select` is not applied locally. It also answers one tool itself, `unbrowse_local_mcps`: the servers in this machine's agent configs (no values), and with `import: true` the same import as `mcps import` (never with keys).

```json
{"mcpServers":{"unbrowse":{"command":"npx","args":["-y","unbrowse","mcp"]}}}
```

### One sign-in for the CLI and MCP

`unbrowse mcp add [claude] [codex]` registers that proxy with Claude Code (user scope) and Codex through their own
`mcp add` commands, for whichever is on PATH when none is named. They then run on the CLI's sign-in: nothing to sign in
to twice, and no token in their config (the proxy reads the CLI's sign-in on each call). A server already named
`unbrowse` (checked with `<host> mcp get`) is left alone: `--replace` removes it first, `--name` picks another name,
`--dry-run` prints the commands. Hosts start servers with a reduced environment, so `UNBROWSE_CONFIG_DIR`,
`XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` and `UNBROWSE_SHARED_SIGNIN` are passed on when set. `UNBROWSE_API_KEY` never
is (it would be a secret in the host's config): a CLI signed in only through it, or only through Claude Code's sign-in,
is told to run `unbrowse login`. On Windows the host commands run through `cmd /c`.

The other way: when the CLI has no sign-in of its own (no `UNBROWSE_API_KEY`, `login` or v1 key), it uses the Unbrowse
sign-in Claude Code made for its MCP server, read from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`).
Only a token for this origin's REST audience counts: the Claude Code plugin's `https://unbrowse.ai/api/mcp` server has
one; a server added as `https://unbrowse.ai/mcp` holds a `/mcp` token, which the REST API refuses. The token is borrowed,
never refreshed (refreshing would sign Claude Code out); once it expires, Claude Code renews it on its next call or you
run `unbrowse login`. `whoami` names the source. On macOS Claude Code keeps these tokens in the Keychain, so nothing is
found there. `UNBROWSE_SHARED_SIGNIN=0` turns it off.

The remote MCP (`/mcp`) is a separate client. This CLI does not speak it and does not install it.
Connect an agent with the commands in [install.md](install.md) and [mcp.md](mcp.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done; for runs, a verified success |
| 1 | Error |
| 2 | `input_required`: answer with `unbrowse resume` |
| 3 | Not signed in, or the site needs a login nobody saved |
| 4 | `succeeded` without verification, or `outcome_unknown` |

## Environment

| Variable | Default |
|---|---|
| `UNBROWSE_API_KEY` | — |
| `UNBROWSE_BASE_URL` | `https://unbrowse.ai` |
| `UNBROWSE_CONFIG_DIR` | `~/.config/unbrowse` |
| `UNBROWSE_NO_OPEN` | unset; set it to never open a browser |
