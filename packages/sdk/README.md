# @unbrowse/sdk

TypeScript client for the Unbrowse API (`https://unbrowse.ai/api/v1`). Node 18.17+, Bun, Deno,
or any runtime with `fetch`. No dependencies. The `unbrowse` CLI is built on it.

```bash
npm install https://github.com/unbrowse-ai/unbrowse-skill/releases/download/v12.0.0-alpha.1/unbrowse-sdk-12.0.0-alpha.1.tgz
```

```ts
import { Unbrowse } from "@unbrowse/sdk";

const ub = new Unbrowse(); // UNBROWSE_API_KEY, https://unbrowse.ai/api/v1

let run = await ub.run({ task: "top stories on Hacker News", idempotencyKey: crypto.randomUUID() });
run = await ub.wait(run.runId);                         // until it leaves accepted/working

// Discover actual capabilities and schemas before selecting a site-specific run.
console.log(await ub.discover("flight search"));
```

Pass an `idempotencyKey` when you may retry: the same key returns the same run instead of starting
a second one.

`new Unbrowse({ apiKey, baseUrl, fetch })`: `apiKey` defaults to `UNBROWSE_API_KEY` (an API key or
an OAuth access token); `baseUrl` takes an origin or an `/api/v1` URL and defaults to
`UNBROWSE_BASE_URL`, then v3. Public registry reads need no key.

## Runs

| Method | Route |
|---|---|
| `run({ task \| capability, targetUrl?, input?, interactionMode?, idempotencyKey? })` | `POST /runs` (key sent as `idempotency_key` + `Idempotency-Key`) |
| `inspect(runId)` | `GET /runs/:id` |
| `wait(runId, { timeoutMs? })` | polls `GET /runs/:id` |
| `events(runId)` | `GET /runs/:id/events` |
| `answer(runId, { field: value })` | `GET /runs/:id`, `POST /runs/:id/responses`, `GET /runs/:id` |
| `resume(runId, expectedStateRevision, responses)` | `POST /runs/:id/responses` |
| `cancel(runId)` | `POST /runs/:id/cancel` |

A run is `succeeded` only when its result is verified (`verified: true`). `input_required` is not a
failure: answer on the same run. `outcome_unknown` means a change may have happened; do not retry
blindly. A run whose site needs a login nobody saved carries `signIn.url`: give it to the person.

## Capabilities and learning

| Method | Route |
|---|---|
| `discover(query)` | `POST /capabilities/search` |
| `capability(id)`, `skills()` | `GET /capabilities/:id`, `GET /skills` |
| `learn({ har \| traces, goal?, title? })` | `POST /learn` |
| `learned(id?)`, `harnessYaml(id)`, `skillMd(id)` | `GET /learned[/:id[/harness.yaml\|/skill.md]]` |

## Account, logins, vault

| Method | Route |
|---|---|
| `me()`, `usage()` | `GET /me`, `GET /usage` |
| `logins.list()`, `.save(login)`, `.remove({ origin } \| { ref })` | `/logins` — values in, masked hints out |
| `accounts.connect({ origin, username, password })`, `accounts.register({ origin, username })` | `/accounts/connections`, `/accounts/register` |
| `vault()` | `GET /vault` — refs and audit, never secrets |

## Public registry

| Method | Route |
|---|---|
| `sites(query?)`, `site(host)` | `GET /sites`, `GET /sites/:host` (no key) |
| `openapi(host)` | `GET /sites/:host/openapi.json` |
| `callTool(host, tool, input)` | `POST /sites/:host/call/:tool` (metered like a run) |
| `siteMcpUrl(host)` | the site as its own MCP server |

## Errors

Every failure throws `UnbrowseError` with `status`, `code` (the server's, e.g. `quota_exceeded`,
`unknown_argument`) and `body`.

## Install helpers

`mcpCommands(url)`, `cursorInstallLink(url)`, `vscodeInstallLink(url)` build install commands and
links for the hosted MCP (`https://unbrowse.ai/mcp`). They never carry a key.
