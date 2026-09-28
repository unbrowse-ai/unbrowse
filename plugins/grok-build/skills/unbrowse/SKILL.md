---
name: unbrowse
description: Search and call websites through Unbrowse's hosted API or remote MCP, reuse indexed site tools, read pages, and learn missing routes in its cloud browser. Use for structured website tasks, authenticated site access, and live canvas planning with Unbrowse.
---

# Unbrowse

Use the hosted service at `https://unbrowse.ai`. Execution, indexed routes and website sessions stay server-side. This skill supplies operating guidance; it does not authenticate the user or start a local MCP server.

## Connect

The MCP and the CLI are different logins. A URL in a client config is not a signed-in session. `unbrowse whoami` succeeding does not mean the MCP is connected, and the CLI bearer is rejected by `/mcp`.

- MCP: use the URL the client already configured. Hosted servers are `https://unbrowse.ai/mcp` and `https://v3.unbrowse.ai/mcp`. If `unbrowse.discover` is not in this session's tool list, stop and reconnect that server's own OAuth. Do not paste the CLI token onto the MCP URL.
- CLI: `unbrowse login` stores an OAuth token for `https://unbrowse.ai/api/v1` only. It is a REST client, not an MCP client.

```sh
claude mcp add --transport http unbrowse https://unbrowse.ai/mcp
```

```json
{"mcpServers":{"unbrowse":{"url":"https://v3.unbrowse.ai/mcp"}}}
```

From a terminal, with the CLI:

```sh
npx skills add unbrowse-ai/unbrowse && npx unbrowse login
```

Adds the Unbrowse skill to your agent and signs in the CLI. Then `npx unbrowse run 'top stories on hacker news'` runs any site from your terminal. The site requests go from your own IP by default; add `--from-unbrowse` to send them from Unbrowse instead. The first command run with no sign-in starts the same browser sign-in and then carries on; without a terminal it exits 3 and asks for `unbrowse login` or `UNBROWSE_API_KEY`.

CLI and SDK: https://github.com/unbrowse-ai/unbrowse
For automation, supply an API key via `UNBROWSE_API_KEY` using the caller's secret manager. Do not put keys into committed config, prompts, command arguments or logs. Create a key in the signed-in console at https://unbrowse.ai/app.

## Host plugins

Packaged installs that bundle this skill, connect Unbrowse and redirect the host's own browser to it (https://github.com/unbrowse-ai/unbrowse/tree/main/plugins):

- Claude Code: `claude plugin marketplace add unbrowse-ai/unbrowse`, then `claude plugin install unbrowse@unbrowse`.
- Codex: `codex plugin marketplace add unbrowse-ai/unbrowse`, then `codex plugin add unbrowse@unbrowse`; set `web_search = "disabled"` to drop built-in search.
- Grok Build: `grok plugin install unbrowse-ai/unbrowse#plugins/grok-build --trust`.
- OpenClaw (`@unbrowse/openclaw`), Hermes (`plugins/hermes`), elizaOS (`@unbrowse/plugin-unbrowse`): native tools or actions over the same MCP.

Hosts that need a stdio server or reject dotted tool names can run `npx unbrowse mcp`: tool names there use `_` (`unbrowse_scrape`). With a plugin installed, built-in web fetch, web search and browser navigation to non-local URLs are refused with a pointer to the matching Unbrowse tool; `UNBROWSE_ALLOW_BUILTIN_BROWSER=1` lifts that for a session.

## Choose the interface

- MCP: discovery, runs, page reading, cloud browsing, indexing, saved-login requests and live canvas cards. These names are MCP tools. They are not CLI commands.
- CLI: `unbrowse discover`, `run`, `inspect`, `resume`, `registry`, `site`, `whoami`. `unbrowse run` never drives a website in a browser (the only browser it opens is the first-use sign-in). There is no `unbrowse browse` and no `unbrowse install`. `unbrowse help` describes the installed version.
- SDK: REST integration and scripting. Consult the public SDK docs for its supported methods; MCP tools and REST methods are not interchangeable names.

Core MCP tools: `unbrowse.discover`, `unbrowse.run`, `unbrowse.inspect`, `unbrowse.resume`, `unbrowse.cancel`, `unbrowse.scrape`, `unbrowse.map`, `unbrowse.sites`, `unbrowse.usage`, `unbrowse.credits`, `unbrowse.forget`, `unbrowse.learn`, `unbrowse.index`, `unbrowse.index.status`, `unbrowse.credentials.list`, `unbrowse.credentials.request`, `unbrowse.credentials.status`, and the cloud browser `unbrowse.browse.open`, `unbrowse.browse.snapshot`, `unbrowse.browse.act`, `unbrowse.browse.finish`, `unbrowse.browse.close`, and session replay `unbrowse.replay.list`, `unbrowse.replay.search`, `unbrowse.replay.get`, `unbrowse.replay.timeline`, `unbrowse.replay.ask`.

[references/tools.json](references/tools.json) contains the exported core MCP input schemas. The connected server's `tools/list` is authoritative: it also includes dynamic tools available to this user's workspace. Never invent a capability ID or input schema.

## Execute a task

1. Discover with `unbrowse.discover {query}`. Inspect returned inputs, choices and hints. Prefer a healthy matching capability; `warm` means HTTP replay, `rendered` needs rendering. Check `unbrowse.sites` for saved session and login state when relevant.
2. Call the selected tool with its listed schema, or `unbrowse.run {capability, input}`. A natural-language `task` can route when no ID was selected. Use a stable `idempotencyKey` for the same intended mutation. For a large answer pass `select` (MCP run tools, `unbrowse.resume`, `unbrowse.inspect`, `POST /api/v1/runs`): paths like `["results[].{id,title,price}", "total"]`. It narrows only what comes back, after verification; billing is unchanged. Results over 40,000 characters are shortened (`truncated: true`); `selectMissing` lists paths that matched nothing.
3. Inspect the returned status and actual result. `input_required` means answer the open requirements on the **same** run: `unbrowse.resume {runId, answers:{field:value}}`. For a choice, pass the listed option's value. Preserve revision checks when supplied.
4. `no_capability` means no reusable route matched. Follow `result.next`: `tool` is `unbrowse.index` (`POST /api/v1/index`, then `GET /api/v1/index/{jobId}`). Call `unbrowse.browse.open` only when that name is in this session's tool list. Do not POST `/api/v1/browse/open`. It is not a route. Report unsupported or blocked sites honestly.
5. Only report completion from a verified result. `outcome_unknown` means a change may have occurred: inspect the effect receipt and destination before retrying. Cancellation stops future dispatches; it does not undo completed effects.

Do not infer business success from HTTP 200, tool transport success, a screenshot, or a generated plan. Do not promise universal coverage or browserless execution on every first request. Obtain the user's authorization for posting, sending, purchasing or other external writes.

## Unbrowse a URL

When the person names a site:

1. If `unbrowse.discover` is not in this session's tool list, the MCP is not signed in. Stop. Name the configured MCP URL and say the CLI login does not cover it.
2. Look the host up (`unbrowse.sites`, or CLI `unbrowse site <host>`). Tools already compiled: use one. Stop.
3. No tools: `unbrowse.index {url, focus}` or `POST /api/v1/index`. Poll `unbrowse.index.status` or `GET /api/v1/index/{jobId}`.
4. `status: failed` and `error.code: model_unavailable`: the indexing model is out of credit. Report the job id and the message. Do not browse instead, and do not start the same job again in a loop.
5. `status: done` with `indexed: 0` means nothing was learned. Say so. `indexed > 0` means call one tool and check the result.

A 202 from `/api/v1/index` is a job id, not a compiled tool.

## Read or learn a site

Use `unbrowse.scrape {url}` for a page (a PDF or .docx URL comes back as markdown text with `metadata.pages`); `unbrowse.map {url}` finds same-site pages. For interactive work with no matching route:

1. `unbrowse.browse.open {url,task}` returns the page and element refs.
2. Use `browse.act` with the latest refs. For ordinary inputs, include a meaningful `name` such as `date` or `query`; exercise every filter the task needs. Refresh the snapshot after page changes.
3. Use `browse.finish {sessionId}` to return the final page and compile observed routes. Two sessions with different inputs help identify reusable parameters. Check `learnError` and `newTool`; browsing success alone does not prove a reusable route exists.
4. Close sessions when finished. `browse.close` still indexes unless `discard:true`.

To cover a whole site ahead of need, `unbrowse.index {url, focus?}` starts a background job: Unbrowse's own agent performs the site's core read-only capabilities, proves each with a browserless replay and adds them to your tools. Follow it with `unbrowse.index.status {jobId}`.

An existing HAR pair can be sent through `unbrowse.learn`. Only submit recordings the user authorized; HARs can contain private data. Private and loopback destinations are refused by the hosted service.

## Session replay

Every cloud-browser session is recorded: your own `unbrowse.browse.open` … `finish` sessions become replays with sid `a_<browse session id>`, with the page recording, each step you took and a screenshot per step. Visitor sessions (people on unbrowse.ai) are visible to unbrowse.ai admins only; agent sessions are visible to the workspace that ran them.

- `unbrowse.replay.list` and `unbrowse.replay.search {query}` find sessions and moments (filters: `source`, `site`, `outcome`, `hasError`, `from`, `to`).
- `unbrowse.replay.get {sid}` returns the summary: intent, outcome, drop-off reason, bugs and key moments.
- `unbrowse.replay.timeline {sid}` returns the session as text lines with times; narrow long ones with `from`/`to` or `kinds`.
- `unbrowse.replay.ask {question}` answers across sessions with citations (session and moment, with a link). Only cite what it returns.

Use it to find out why a learn failed (`timeline` of the `a_…` session) before retrying. REST: `/api/v1/replays…`; SDK: `client.replays.*`; CLI: `unbrowse replay list|search|show|timeline|ask`.

## Website sign-in

Unbrowse account sign-in and a website's saved login are separate. Never ask for passwords in chat or type credentials via ordinary tool arguments.

- On a login page, use `browse.act {sessionId,action:"autofill"}`, or `vault:"username"|"email"|"password"|"totp"` on a fill action. Values go directly from the vault to the site.
- Missing login: present the returned `signIn.url` or `details.url` save-login link. `unbrowse.credentials.request` can create one; `credentials.status` checks whether it was fulfilled. Resume only after it is ready.
- Do not bypass CAPTCHA, MFA or human verification. Present the supported handoff or report the blocker.
- Saved sessions are reused; do not sign in again merely because another task started.

Read-only secretless learned routes may be scrubbed and shared to the public registry. The owner can opt out in the console. Logins, private session values and writes are not public tool definitions.

## Serving many users (orgs)

When the caller is an agent a builder runs for its own users, it uses an org key and names the user on every call: `X-Unbrowse-End-User: <that user's id>` (REST and MCP headers). Each user has their own logins and sessions.

- Always send the id of the user the task is for. Never reuse one user's id for another user's task, and never omit it: without it the call acts as the org itself, not any user.
- A `signIn.url` (a `/connect/…` link) is for that same user: deliver it to them, not to the builder or another user. They save the login there without an Unbrowse account; wait for `unbrowse.credentials.status` to be `fulfilled`, then call again.
- `org__…` tools are shared by the org's users (read-only, no logins); `my__…` tools are the current user's own.
- Quota errors are the org's balance, not the user's. Report them to the builder.

Guide: https://github.com/lekt9/unbrowse6/blob/master/docs/orgs.md

## Live canvas

When `unbrowse.canvas.read` and `.put` are listed, they connect to https://unbrowse.ai/app/canvas in the same signed-in workspace.

Use notes and plans for static text; results for source data; drafts for proposed responses. Give child cards `parentId` to unfold from a result. Read current card revisions before updating; supply `expectedRevision` and preserve human edits. Put source links beside factual claims. Label proposed text as a draft.

`canvas.put` creates cards, not external sends. Preparing reply drafts does not authorize posting them. Sending is reviewed separately in the canvas UI.

## Limits and recovery

- 401: reconnect that door. CLI 401 is `unbrowse login` for `/api/v1`. MCP 401 is the MCP server's own OAuth. One token does not fix the other.
- `model_unavailable` on an index job: the indexing model is out of credit. Report the job id. No tools were compiled. This is not `unbrowse.usage` and not the site.
- Quota/payment error: show the returned limit and console link; do not retry payments blindly. When listed, `unbrowse.credits` shows free/paid balances and can return a checkout link for the user. Opening a billing link does not authorize payment.
- Verification or login block: use the returned handoff; don't present a challenge page as source content.
- Timeout on a write: inspect the existing run before retrying.
- Pricing and quotas: consult the account's current plan and `unbrowse.usage`; this skill does not fix prices.
