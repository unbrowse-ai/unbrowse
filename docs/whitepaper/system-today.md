# System Today

This page describes the Unbrowse system that runs today. It is not the full system the paper describes.

Unbrowse has two parts:

- **The hosted service** at `https://unbrowse.ai`. It is closed source. It runs the cloud browser, the learn loop, replay, the registry, the vault and billing.
- **The client** in this repo. It is open source and thin: the `@unbrowse/sdk` REST client (`packages/sdk`) and the `unbrowse` CLI on it (`packages/cli`). It calls the service's REST API at `/api/v1`; agents use the remote MCP at `/mcp`. It runs no browser and indexes nothing locally. `skill/SKILL.md` is the agent contract.

Everything below is behavior of the hosted service unless it names a client file.

## Status labels

The service keeps an acceptance ledger: each outcome has a check that can fail. This page uses it.

- **Shipped**: running, and its acceptance check is closed with evidence.
- **Shipped, check open**: running in the service, but its acceptance check is not yet closed.
- **Not shipped**: described somewhere (usually the paper), not in the service.

## The core loop

1. An agent asks for a task, by capability id or in plain language (`unbrowse.run`).
2. The service looks in the caller's private space, then the public registry (`unbrowse.discover`).
3. If a learned capability fits, it replays it over first-party HTTP. No browser.
4. If nothing fits, the agent does the task once in the service's cloud browser (`unbrowse.browse.*`). The browser records the whole session. The task still gets done.
5. On finish, the service compiles the recorded sessions into a `learned.*` capability. Two sessions with different inputs give a callable capability. Next time, step 3 answers.

The first request is fulfilled while the route is indexed. No separate "learn" call is needed.

| Piece | Status |
| --- | --- |
| Cloud browser (patchright, headful), driven with `@ref` snapshots, recording from the first navigation | Shipped |
| Passive indexing on `browse.finish` / `browse.close` | Shipped |
| `unbrowse.learn` from HAR files or traces | Shipped |
| Replay over first-party HTTP, with mid-run inputs and choices | Shipped |
| Survives restarts; each user's data in its own partition | Shipped |

## What the learn loop does

From two or more recorded sessions it:

- groups requests into families and drops pixels, polls and bot-manager traffic
- diffs the sessions to find which values the caller fills in (inputs) and which the user picks (choices)
- traces every token and id (csrf, quote tokens, selected ids) back to the response that produced it
- picks the outcome: the request that carried what the user typed, or, when nothing was typed, the read whose answer carries what the page showed
- keeps the site's other API knobs (sort, page size, paging) as optional parameters with recorded defaults

Session cookies, csrf values and tokens are never caller inputs. Compiled packages hold placeholders, never captured session values.

If a typed value never reached a replayable request (client-side filtering, a third-party search service), nothing is indexed and the result says `typed_input_unused`.

When no API answers a read (a profile, an article), the page the session landed on is learned as a page read. It returns `{ title, text, links }` and its input is the part of the address that changes. This path is **shipped, check open**.

## Capabilities and harness YAML

Each capability is a versioned `unbrowse/v1alpha1` YAML package. It declares slots, operations, bindings, guards and independent outcome checks. The runtime executes a typed form of it. No eval, no shell, no website-provided expressions.

Lifecycle:

- `observed`: has unexplained values. Stays browser-backed. Not trusted.
- `candidate`: network-callable.
- `validated`: passed validation for this exact package digest.

Each capability also gets a SKILL.md. Both are readable over REST (`/api/v1/learned/:id/harness.yaml`, `/api/v1/learned/:id/skill.md`).

## Run statuses

- `succeeded`: the declared business outcome was independently verified. HTTP 200 is not enough.
- `input_required`: waiting on an answer. Resume the same run (`unbrowse.resume`).
- `outcome_unknown`: a write may have landed. It is never re-sent automatically.
- `failed` / `cancelled`: known effects are kept.

## When HTTP replay is not enough

| Situation | What happens | Status |
| --- | --- | --- |
| Bot challenge mid-run | Retried once with a Chrome TLS fingerprint, then with clearance the browser earned. Otherwise a same-session verification requirement, never a fresh context | Shipped |
| A header only the live page can compute | A browser loads the page once, lends cookies and token headers, closes; the chain continues over HTTP | Shipped |
| Client-side search, or HTTP cannot finish a read | Render fallback: the service's own browser renders the page; if that is walled, a hosted third-party renderer. Labelled `via: "rendered"`; the renderer's cost passes through | Shipped |
| Render fallback is slow | After a bound (default 45 s) the run keeps its HTTP answer | Shipped, check open |

## Routing

`unbrowse.run` with a plain-language task routes to a learned capability. When a TypeSafe API key is configured, Jev (TypeSafe System One) picks among eligible candidates. It may abstain. If Jev is down, routing falls back to a deterministic ranking. Jev never widens the eligible set. **Shipped.**

`unbrowse.discover` returns hints per capability: `health`, `state` (`warm` replays over HTTP, `rendered` uses a browser, `cold` never ran), p50/p95 latency from real runs, success rate, and `next` (the exact call or fix). **Shipped.**

## Public registry

Next to each user's private space there is a public registry of pre-indexed site capabilities (`public.<host>.<goal>`). Any workspace can discover and run them. Runs, usage and session cache stay in the caller's workspace.

- Only read-only, secretless, one-input lookups publish.
- A capability publishes only after a scrubbed copy, with no cookies, answers two probe words plus one unseen word and fails a nonsense query.
- Routes a user teaches are auto-shared by default (read-only, secretless, public host only; the user's own values dropped). The owner can opt out. Logins and writes are never shared.
- A revalidation pass re-runs public capabilities with fresh words and unpublishes ones that keep failing. Discover withholds public tools whose recent runs fail, unless the query names the site.
- The crawler honours robots.txt.

Status: **shipped, check open.** The registry reliability bar is not met yet (see [Evaluation](./evaluation.md)).

## Sites as tools

Every compiled site is also:

- its own MCP server: `/api/v1/sites/<host>/mcp`
- an OpenAPI 3.1 document: `/api/v1/sites/<host>/openapi.json`

Tools carry an input schema and an output schema inferred from verified responses. Your own capabilities show in the main MCP `tools/list` as `my__<site>__<op>`. Tool calls bill like runs. **Shipped, check open.**

## Logins and the vault

See [Credential Sovereignty](./credential-sovereignty.md). In short:

- A password manager whose values the model never reads. Logins are sealed in the workspace vault. The cloud browser fills them into the page. Tool results show `[from vault]`.
- CSV import from Chrome, Bitwarden, 1Password, LastPass, Firefox, Apple Passwords and Dashlane.
- Auto sign-in on replay: a browserless read that hits a login wall on a site with a saved login triggers one browser sign-in, then keeps replaying over HTTP.
- Session reuse: the signed-in session is cached and seeds later runs; the login step is skipped.
- `unbrowse.sites` reports each site's state: public or behind a sign-in, kept session (active / expired / logged_out / none), saved login, learned tools, bot checks.
- A zero-knowledge Private vault (only its owner can decrypt) next to an Agent vault agents use unattended. This is the newest piece.

Status: all **shipped, check open** except the vault's core sealing and restart survival, which is **shipped**.

## Billing

- 500 verified calls a month free, then $10 per 10,000.
- Only verified successes bill, each once. Failed, refused, challenged and `input_required` runs cost nothing. Policy denials are free.
- A rendered run adds the hosted renderer's cost as passthrough.
- `unbrowse.usage` and `GET /api/v1/usage` show calls, rendered runs, passthrough cost and quota left.
- Past a monthly quota, a run is refused with 402 `quota_exceeded` before any upstream request.

Status: **shipped.**

### x402 pay-per-call

No account is needed. `POST /api/v1/runs` and `POST /api/v1/sites/<host>/call/<tool>` without credentials answer 402 with x402 v2 payment requirements: exact scheme, USDC on Base, $0.001 per call, plus a Bazaar discovery extension with the endpoint's schemas. The caller retries with a `payment-signature` header. It settles only if the run succeeds. **Shipped, check open.**

## Access surfaces

- Remote MCP at `/mcp` (Streamable HTTP).
- REST at `/api/v1`. The authenticated principal decides the workspace; a caller-supplied workspace id is never authority.
- Auth: an API key (`Authorization: Bearer ub_live_…`), or OAuth 2.1 with PKCE for remote MCP clients (**shipped, check open**).
- This repo's client: `@unbrowse/sdk` and the `unbrowse` CLI.
- A Tardigrade actor that exposes learned capabilities as tools (**shipped**).

## MCP tools

`unbrowse.discover`, `unbrowse.sites`, `unbrowse.usage`, `unbrowse.run`, `unbrowse.inspect`, `unbrowse.resume`, `unbrowse.cancel`, `unbrowse.forget`, `unbrowse.learn`, `unbrowse.browse.open` / `.snapshot` / `.act` / `.finish` / `.close`, `unbrowse.credentials.list` / `.request` / `.status`. When three or fewer skills match, dedicated `unbrowse.skill.*` tools are listed with slot schemas from the harness YAML.

## What does not exist today

- Any route marketplace with per-route prices, contributor payouts or fee splits. Pricing is one flat meter.
- Validator markets, staking, signed attestations, TEE or sandbox proofs.
- Embedding-based composite ranking as described in the paper.
- Local capture or local execution in the client. The client is a transport.

See [Paper vs Product Status](./paper-vs-product.md) and [Coming Soon](./coming-soon.md).
