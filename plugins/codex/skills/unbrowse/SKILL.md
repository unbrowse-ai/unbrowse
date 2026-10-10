---
name: unbrowse
description: Search and call websites through Unbrowse's hosted API or remote MCP, reuse indexed site tools, read pages, and learn missing routes in its cloud browser. Use for structured website tasks, and authenticated site access with Unbrowse.
---

# Unbrowse

Use the hosted service at `https://unbrowse.ai`. Execution, indexed routes and website sessions stay server-side. This skill supplies operating guidance; signing in is OAuth, below.

## Onboarding: sign in with OAuth

Sign-in is OAuth in the person's browser: an emailed sign-in link, then **Allow**. No password, and nothing to paste. Never ask the person for a token or key in chat.

Check first, then sign in only what is missing:

1. MCP: if `unbrowse_discover` is in this session's tool list, the MCP is signed in.
2. CLI: `npx unbrowse whoami`. Exit 0 means signed in. Exit 3 means not signed in.

Sign in the MCP (agent hosts):

```sh
claude mcp add --transport http unbrowse https://unbrowse.ai/mcp
```

```json
{"mcpServers":{"unbrowse":{"url":"https://unbrowse.ai/mcp"}}}
```

The host runs the OAuth sign-in itself (in Claude Code: `/mcp`, pick `unbrowse`, Authenticate). Do not put a bearer header in the config; with one set, hosts skip OAuth. A URL in a config is not a signed-in session: until the host finishes OAuth, the Unbrowse tools are not listed.

Sign in the CLI:

```sh
npx skills add unbrowse-ai/unbrowse && npx unbrowse login
```

`unbrowse login` opens the sign-in page in the browser on this machine. The person enters their email, opens the link, presses **Allow**; the CLI prints `Signed in to https://unbrowse.ai (workspace ws_…)` and stores the token at `~/.config/unbrowse/cli.json` (mode 0600, refreshed automatically).

From an agent's shell (no terminal for the person): run `npx unbrowse login --no-open` in the background, give the person the `https://unbrowse.ai/authorize?…` link it prints, and wait for the `Signed in` line. The link returns to `127.0.0.1` on this machine, so the person must open it in a browser on the same machine. On a remote or headless box, use an API key instead (below). Any other command run with no sign-in starts the same browser sign-in when it has a terminal; without one it exits 3 and asks for `unbrowse login`.

Then the first call: `npx unbrowse run 'top stories on hacker news'`. The site requests go from the person's own IP by default; `--from-unbrowse` sends them from Unbrowse instead.

`npx unbrowse mcp` (a stdio MCP for hosts that need one) uses the CLI sign-in. A remote MCP in a host config uses only that host's own OAuth: one sign-in does not cover the other, and the CLI token does not go into an MCP config.

For automation and CI without a browser, set `UNBROWSE_API_KEY` from the caller's secret manager (create a key in the signed-in console at https://unbrowse.ai/app). Never put keys into committed config, prompts, command arguments or logs.

CLI and SDK: https://github.com/unbrowse-ai/unbrowse

## Host plugins

Packaged installs that bundle this skill, connect Unbrowse and redirect the host's own browser to it (https://github.com/unbrowse-ai/unbrowse/tree/main/plugins):

- Claude Code: `claude plugin marketplace add unbrowse-ai/unbrowse`, then `claude plugin install unbrowse@unbrowse`.
- Codex: `codex plugin marketplace add unbrowse-ai/unbrowse`, then `codex plugin add unbrowse@unbrowse`; set `web_search = "disabled"` to drop built-in search.
- Grok Build: `grok plugin install unbrowse-ai/unbrowse#plugins/grok-build --trust`.
- OpenClaw (`@unbrowse/openclaw`), Hermes (`plugins/hermes`), elizaOS (`@unbrowse/plugin-unbrowse`): native tools or actions over the same MCP.

Hosts that need a stdio server or reject dotted tool names can run `npx unbrowse mcp`: tool names there use `_` (`unbrowse_scrape`). With a plugin installed, built-in web fetch, web search and browser navigation to non-local URLs are refused with a pointer to the matching Unbrowse tool; `UNBROWSE_ALLOW_BUILTIN_BROWSER=1` lifts that for a session.

## Choose the interface

- MCP: discovery, runs, page reading, cloud browsing, indexing and saved-login requests. These names are MCP tools. They are not CLI commands.
- CLI: `unbrowse discover`, `run`, `inspect`, `resume`, `scrape <url>` (one page as markdown), `index <url>` (teach a site; `index status`), `registry`, `site`, `whoami`. `scrape` and `index` need CLI 12.2.0 or later. `unbrowse run` never drives a website in a browser (the only browser it opens is the first-use sign-in). There is no `unbrowse browse` and no `unbrowse install`. `unbrowse help` describes the installed version.
- SDK: REST integration and scripting. Consult the public SDK docs for its supported methods; MCP tools and REST methods are not interchangeable names.

Core MCP tools: `unbrowse_discover`, `unbrowse_run`, `unbrowse_inspect`, `unbrowse_resume`, `unbrowse_cancel`, `unbrowse_scrape`, `unbrowse_map`, `unbrowse_sites`, `unbrowse_usage`, `unbrowse_credits`, `unbrowse_forget`, `unbrowse_learn`, `unbrowse_index`, `unbrowse_index_status`, `unbrowse_credentials_list`, `unbrowse_credentials_request`, `unbrowse_credentials_status`, `unbrowse_connect` (connect an app's own MCP server, such as Linear, Notion or GitHub, so its tools run as the person: an app with sign-in returns a link the person opens), and the cloud browser `unbrowse_browse_open`, `unbrowse_browse_snapshot`, `unbrowse_browse_act`, `unbrowse_browse_finish`, `unbrowse_browse_close`.

[references/tools.json](references/tools.json) contains the exported core MCP input schemas. The connected server's `tools/list` is authoritative: it also includes dynamic tools available to this user's workspace. Never invent a capability ID or input schema.

## Execute a task

1. Discover with `unbrowse_discover {query}`. Inspect returned inputs, choices and hints. Prefer a healthy matching capability; `warm` means HTTP replay, `rendered` needs rendering. Check `unbrowse_sites` for saved session and login state when relevant. Public tools carry `version`, the Unbrowse version that generated them (YYYY.MM.DD); among equal matches the newest comes first, and `minVersion` leaves older ones out.
2. Call the selected tool with its listed schema, or `unbrowse_run {capability, input}`. A natural-language `task` can route when no ID was selected. Use a stable `idempotencyKey` for the same intended mutation. For a large answer pass `select` (MCP run tools, `unbrowse_resume`, `unbrowse_inspect`, `POST /api/v1/runs`): paths like `["results[].{id,title,price}", "total"]`. It narrows only what comes back, after verification; billing is unchanged. Results over 40,000 characters are shortened (`truncated: true`); `selectMissing` lists paths that matched nothing.
3. Inspect the returned status and actual result. `input_required` means answer the open requirements on the **same** run: `unbrowse_resume {runId, answers:{field:value}}`. For a choice, pass the listed option's value. Preserve revision checks when supplied.
4. `no_capability` means no reusable route matched. Follow `result.next`: `tool` is `unbrowse_index` (`POST /api/v1/index`, then `GET /api/v1/index/{jobId}`; CLI `unbrowse index <url>`). To answer now, read the page instead: `unbrowse_scrape` (CLI `unbrowse scrape <url>`). Call `unbrowse_browse_open` only when that name is in this session's tool list. Do not POST `/api/v1/browse/open`. It is not a route. Report unsupported or blocked sites honestly.
5. Only report completion from a verified result. `outcome_unknown` means a change may have occurred: inspect the effect receipt and destination before retrying. Cancellation stops future dispatches; it does not undo completed effects.

Do not infer business success from HTTP 200, tool transport success, a screenshot, or a generated plan. Do not promise universal coverage or browserless execution on every first request. Obtain the user's authorization for posting, sending, purchasing or other external writes.

## Unbrowse a URL

When the person names a site:

1. If `unbrowse_discover` is not in this session's tool list, the MCP is not signed in. Stop. Name the configured MCP URL and say the CLI login does not cover it.
2. Look the host up (`unbrowse_sites`, or CLI `unbrowse site <host>`). Tools already compiled: use one. Stop.
3. No tools: `unbrowse_index {url, focus}` or `POST /api/v1/index`. Poll `unbrowse_index_status` or `GET /api/v1/index/{jobId}`.
4. `status: failed` and `error.code: model_unavailable`: the indexing model is out of credit. Report the job id and the message. Do not browse instead, and do not start the same job again in a loop.
5. `status: done` with `indexed: 0` means nothing was learned. Say so. `indexed > 0` means call one tool and check the result.

A 202 from `/api/v1/index` is a job id, not a compiled tool.

## A site's tools over plain HTTP

Each compiled site is also a REST API, for code rather than an agent session:

- `GET https://unbrowse.ai/api/v1/sites/<host>/openapi.json`: OpenAPI 3.1, one operation per tool, typed inputs, an `example` input it was verified with, every status and header. No key needed to read.
- `POST https://unbrowse.ai/api/v1/sites/<host>/call/<tool>` with the tool's inputs as the JSON body and `Authorization: Bearer <key>`. Options: `x-unbrowse-deadline-ms`, `Idempotency-Key`, `select`. `202` means `input_required`; `504 run_timeout` gives a `runId` to poll; `409 tool_quarantined` means use another tool.
- SDK: `new Unbrowse().callTool(host, tool, input)`.

Contract and examples: https://unbrowse.ai/docs/site-apis.md

## Read or learn a site

Prefer `unbrowse_discover` and a matching tool or `unbrowse_run` for structured data and site tasks. `unbrowse_scrape {url}` is a **last resort for static pages and documents**, only when no suitable API or learned tool is available. A PDF, .docx, .xls or .xlsx URL comes back as extracted markdown text (`metadata.pages` for PDFs; spreadsheets preserve sheet names, rows and formatted values). `metadata.truncated` marks bounded extraction; `formats: ["raw"]` returns the exact document bytes as base64; `unbrowse_map {url}` finds same-site URLs. A known URL or scrape's rendering support does not make it the default. For dynamic content, search, pagination or interaction with no matching route, use `unbrowse_index` or the available cloud browser tools to learn and replay the site's API:

1. `unbrowse_browse_open {url,task}` returns the page and element refs.
2. Use `browse.act` with the latest refs. For ordinary inputs, include a meaningful `name` such as `date` or `query`; exercise every filter the task needs. Refresh the snapshot after page changes.
3. Use `browse.finish {sessionId}` to return the final page and compile observed routes. Two sessions with different inputs help identify reusable parameters. Check `learnError` and `newTool`; browsing success alone does not prove a reusable route exists.
4. Close sessions when finished. `browse.close` still indexes unless `discard:true`.

To cover a whole site ahead of need, `unbrowse_index {url, focus?, maxCapabilities?}` starts a background job: Unbrowse's own agent performs the site's core read-only capabilities, proves each with a browserless replay and adds them to your tools. Follow it with `unbrowse_index_status {jobId}`. `maxCapabilities` caps every tool the job indexes (declared, sitemap page types and recorded flows together). A `focus` keeps only sitemap page types that match it, and none when it names flows such as paging, page size, filters or search. Query keys in the start URL (`?page=0&pageSize=100`) become the tool's inputs. `stoppedReason` says why a job ended. The time budget is extended once, by half, while tools are still being proven.

An existing HAR pair can be sent through `unbrowse_learn`. Only submit recordings the user authorized; HARs can contain private data. Private and loopback destinations are refused by the hosted service.

## Website sign-in

Unbrowse account sign-in and a website's saved login are separate. Never ask for passwords in chat or type credentials via ordinary tool arguments.

- On a login page, use `browse.act {sessionId,action:"autofill"}`, or `vault:"username"|"email"|"password"|"totp"` on a fill action. Values go directly from the vault to the site.
- Missing login: present the returned `signIn.url` or `details.url` save-login link. `unbrowse_credentials_request` can create one; `credentials.status` checks whether it was fulfilled. Resume only after it is ready.
- Do not bypass CAPTCHA, MFA or human verification. Present the supported handoff or report the blocker.
- Saved sessions are reused automatically (the person can turn that off per site or for the whole workspace); do not sign in again merely because another task started.

Read-only secretless learned routes may be scrubbed and shared to the public registry. The owner can opt out in the console. Logins, private session values and writes are not public tool definitions.

## Serving many users (orgs)

When the caller is an agent a builder runs for its own users, it uses an org key and names the user on every call: `X-Unbrowse-End-User: <that user's id>` (REST and MCP headers). Each user has their own logins and sessions.

- Always send the id of the user the task is for. Never reuse one user's id for another user's task, and never omit it: without it the call acts as the org itself, not any user.
- A `signIn.url` (a `/connect/…` link) is for that same user: deliver it to them, not to the builder or another user. They save the login there without an Unbrowse account; wait for `unbrowse_credentials_status` to be `fulfilled`, then call again.
- `org__…` tools are shared by the org's users (read-only, no logins); `my__…` tools are the current user's own.
- Quota errors are the org's balance, not the user's. Report them to the builder.

Guide: https://github.com/lekt9/unbrowse6/blob/master/docs/orgs.md

## Limits and recovery

- 401: sign that door in again with OAuth. CLI 401: `npx unbrowse login`. Remote MCP 401: the host's own OAuth for that server (Claude Code: `/mcp`). One sign-in does not fix the other.
- `model_unavailable` on an index job: the indexing model is out of credit. Report the job id. No tools were compiled. This is not `unbrowse_usage` and not the site.
- Quota/payment error: show the returned limit and console link; do not retry payments blindly. When listed, `unbrowse_credits` shows free/paid balances and can return a checkout link for the user. Opening a billing link does not authorize payment.
- Verification or login block: use the returned handoff; don't present a challenge page as source content.
- Timeout on a write: inspect the existing run before retrying.
- Pricing and quotas: consult the account's current plan and `unbrowse_usage`; this skill does not fix prices.
