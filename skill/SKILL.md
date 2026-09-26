---
name: unbrowse
description: Search and call websites through Unbrowse's hosted API or remote MCP, reuse indexed site tools, read pages, and learn missing routes in its cloud browser. Use for structured website tasks, authenticated site access, and live canvas planning with Unbrowse.
---

# Unbrowse

Use the hosted service at `https://v3.unbrowse.ai`. Execution, indexed routes and website sessions stay server-side. This skill supplies operating guidance; it does not authenticate the user or start a local MCP server.

## Connect

Prefer the remote MCP for agents:

```sh
claude mcp add --transport http unbrowse https://v3.unbrowse.ai/mcp
```

Complete sign-in through the MCP client's OAuth flow. Other clients can use:

```json
{"mcpServers":{"unbrowse":{"url":"https://v3.unbrowse.ai/mcp"}}}
```

CLI installation and SDK instructions: https://github.com/unbrowse-ai/unbrowse-skill#readme
Use the client version identified there; older npm versions may target a different service.
For automation, supply an API key via `UNBROWSE_API_KEY` using the caller's secret manager. Do not put keys into committed config, prompts, command arguments or logs. Create a key in the signed-in console at https://v3.unbrowse.ai/app.

## Choose the interface

- MCP: discovery, runs, page reading, cloud browsing, saved-login requests and live canvas cards.
- CLI: `unbrowse discover`, `run`, `inspect`, `resume`, `registry`; `unbrowse install` prints MCP configuration. `unbrowse help` describes the installed version.
- SDK: REST integration and scripting. Consult the public SDK docs for its supported methods; MCP tools and REST methods are not interchangeable names.

[references/tools.json](references/tools.json) contains the exported core MCP input schemas. The connected server's `tools/list` is authoritative: it also includes dynamic tools available to this user's workspace. Never invent a capability ID or input schema.

## Execute a task

1. Discover with `unbrowse.discover {query}`. Inspect returned inputs, choices and hints. Prefer a healthy matching capability; `warm` means HTTP replay, `rendered` needs rendering. Check `unbrowse.sites` for saved session and login state when relevant.
2. Call the selected tool with its listed schema, or `unbrowse.run {capability, input}`. A natural-language `task` can route when no ID was selected. Use a stable `idempotencyKey` for the same intended mutation.
3. Inspect the returned status and actual result. `input_required` means answer the open requirements on the **same** run: `unbrowse.resume {runId, answers:{field:value}}`. For a choice, pass the listed option's value. Preserve revision checks when supplied.
4. `no_capability` means no reusable route matched. If browsing is available, do the task through `unbrowse.browse.*`, then finish to learn it. Report unsupported or blocked sites honestly.
5. Only report completion from a verified result. `outcome_unknown` means a change may have occurred: inspect the effect receipt and destination before retrying. Cancellation stops future dispatches; it does not undo completed effects.

Do not infer business success from HTTP 200, tool transport success, a screenshot, or a generated plan. Do not promise universal coverage or browserless execution on every first request. Obtain the user's authorization for posting, sending, purchasing or other external writes.

## Read or learn a site

Use `unbrowse.scrape {url}` for a page; `unbrowse.map {url}` finds same-site pages. For interactive work with no matching route:

1. `unbrowse.browse.open {url,task}` returns the page and element refs.
2. Use `browse.act` with the latest refs. For ordinary inputs, include a meaningful `name` such as `date` or `query`; exercise every filter the task needs. Refresh the snapshot after page changes.
3. Use `browse.finish {sessionId}` to return the final page and compile observed routes. Two sessions with different inputs help identify reusable parameters. Check `learnError` and `newTool`; browsing success alone does not prove a reusable route exists.
4. Close sessions when finished. `browse.close` still indexes unless `discard:true`.

An existing HAR pair can be sent through `unbrowse.learn`. Only submit recordings the user authorized; HARs can contain private data. Private and loopback destinations are refused by the hosted service.

## Website sign-in

Unbrowse account sign-in and a website's saved login are separate. Never ask for passwords in chat or type credentials via ordinary tool arguments.

- On a login page, use `browse.act {sessionId,action:"autofill"}`, or `vault:"username"|"email"|"password"|"totp"` on a fill action. Values go directly from the vault to the site.
- Missing login: present the returned `signIn.url` or `details.url` save-login link. `unbrowse.credentials.request` can create one; `credentials.status` checks whether it was fulfilled. Resume only after it is ready.
- Do not bypass CAPTCHA, MFA or human verification. Present the supported handoff or report the blocker.
- Saved sessions are reused; do not sign in again merely because another task started.

Read-only secretless learned routes may be scrubbed and shared to the public registry. The owner can opt out in the console. Logins, private session values and writes are not public tool definitions.

## Live canvas

When `unbrowse.canvas.read` and `.put` are listed, they connect to https://v3.unbrowse.ai/app/canvas in the same signed-in workspace.

Use notes and plans for static text; results for source data; drafts for proposed responses. Give child cards `parentId` to unfold from a result. Read current card revisions before updating; supply `expectedRevision` and preserve human edits. Put source links beside factual claims. Label proposed text as a draft.

`canvas.put` creates cards, not external sends. Preparing reply drafts does not authorize posting them. Sending is reviewed separately in the canvas UI.

## Limits and recovery

- 401: reconnect Unbrowse or replace the caller's expired key.
- Quota/payment error: show the returned limit and console link; do not retry payments blindly. When listed, `unbrowse.credits` shows free/paid balances and can return a checkout link for the user. Opening a billing link does not authorize payment.
- Verification or login block: use the returned handoff; don't present a challenge page as source content.
- Timeout on a write: inspect the existing run before retrying.
- Pricing and quotas: consult the account's current plan and `unbrowse.usage`; this skill does not fix prices.
