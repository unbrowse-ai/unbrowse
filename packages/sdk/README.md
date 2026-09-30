# @unbrowse/sdk

TypeScript client for the Unbrowse API (`https://unbrowse.ai/api/v1`). Node 18.17+, Bun, Deno,
or any runtime with `fetch`. No dependencies. The `unbrowse` CLI is built on it.

```bash
npm install https://github.com/unbrowse-ai/unbrowse/releases/download/v12.0.1/unbrowse-sdk-12.0.1.tgz
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
| `runOnClient(request, { fetch?, onRequest?, timeoutMs? })` | `POST /runs` with `egress: "client"`, then `POST /egress/:id` per request |
| `egress(egressId)` / `answerEgress(egressId, requestId, { response } \| { error })` / `closeEgress(egressId)` | `GET` / `POST` / `DELETE /egress/:id` |

`runOnClient` sends the run's requests to the website from this machine, so the site sees your IP;
Unbrowse decides each request and reads each response, and never contacts the site itself:

```ts
const run = await unbrowse.runOnClient({ capability: "hn.top_stories", input: { limit: 3 } });
// Your own network stack or proxy, and a look at each request before it leaves:
await unbrowse.runOnClient({ task: "search eatigo for italian" }, { fetch: myFetch, onRequest: (r) => allowed(r.url) });
```

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

## Saved queries

A question compiled once into your own API. Write what changes as `{placeholders}`; compiling runs it once with the
example values (a real, verified run), pins the tool it used and learns where each value goes. Calls then run that
tool directly — no routing, no model, the same answer shape every time — at `GET /api/v1/q/:id?param=…`.

```ts
const q = await ub.compile("search hn for {topic}", { example: { topic: "rust" }, maxAge: 300 });
const { result, cached } = await q.call({ topic: "python" });   // or ub.query(q.id, { topic: "python" })
```

| Method | Route |
|---|---|
| `compile(query, { example?, map?, name?, maxAge? })` | `POST /queries` |
| `query(id, params, { fresh? })`, `handle.call(params)` | `POST /q/:id` |
| `queries.list()`, `.get(id)`, `.settings(id, { name?, maxAge? })`, `.recompile(id, example?)`, `.remove(id)` | `/queries[/:id[/settings\|/recompile]]` |

`maxAge` (seconds, default 0) reuses an answer for the same params; a reused answer (`cached: true`) is not billed.
When the site changes, a call fails with `schema_changed` (the answer lost fields it had) or `stale` (its tool is
gone) instead of returning something different: `queries.recompile(id)` accepts the new shape.

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
