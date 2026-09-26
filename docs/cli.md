# CLI reference

`unbrowse <command> [args] [--json] [--base-url URL] [--no-open]`

A thin shell over the REST API (`/api/v1`, see [api.md](api.md)). Output is JSON on stdout;
messages go to stderr. Agents that need the cloud browser use the hosted MCP ([mcp.md](mcp.md)).

## Account

| Command | Route |
|---|---|
| `login` | Browser sign-in: OAuth 2.1 with PKCE and a loopback redirect; stores the token |
| `login --key ub_live_…` | Stores an API key (create one in the console, MCP & keys) |
| `logout` | Deletes the stored sign-in |
| `whoami` | `GET /me` |
| `usage` | `GET /usage` |

Credentials are read in this order: `UNBROWSE_API_KEY`, the stored key, the stored OAuth token
(refreshed when it is about to expire). Stored at `~/.config/unbrowse/cli.json`, mode 0600.

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

Values are typed: `adults=2` is a number, `flex=true` a boolean, `x='{"a":1}'` JSON, anything
else a string. `resume` names requirements by field (`origin=CDG`) and answers on the same run.

## Teaching

| Command | Route |
|---|---|
| `learn a.har b.har [--title T] [--goal G]` | `POST /learn` |
| `learned [id]` | `GET /learned`, `GET /learned/:id` |

Record the task twice with different inputs (a HAR export from devtools) and pass both. Doing a
task in the cloud browser is an MCP flow (`unbrowse.browse.*`), not a CLI command.

## Logins

| Command | Route |
|---|---|
| `logins` | `GET /logins` — masked hints, never values |
| `logins remove <origin>` | `POST /logins/remove` |

The CLI never takes a password. When a run needs a login nobody saved, it opens the one-time
save-login page and exits 3. See [logins-and-vault.md](logins-and-vault.md).

## Public registry (no account)

| Command | Route |
|---|---|
| `registry [query]` | `GET /sites?q=` |
| `site <host>` | `GET /sites/:host` |

## MCP

| Command | Does |
|---|---|
| `install` | Prints the commands that add the hosted MCP to Claude Code, Codex and other clients |

They carry the server URL only; your MCP client runs the OAuth sign-in.

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
