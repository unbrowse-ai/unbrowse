---
read_when:
  - changing execute, auth refresh, capture, resolve, endpoint replay, workflow recipes, or stale skill recovery behavior
  - investigating 400, 401, 403, 404, empty result, timeout, or GraphQL query-id drift during execute
  - designing dynamic dependency hydration, latest-observed-request replay, or browser-seeded self-repair
---

# Stale-Resistant Replay

## Goal

Unbrowse should make staleness an internal repair event, not a user-facing dead end.

The product model is:

```
intent -> skill recipe -> hydrate current dependencies -> execute -> repair silently if stale
```

The weak model is static replay:

```
captured URL + captured headers + captured params -> replay later
```

Static replay breaks when auth, feature flags, GraphQL query IDs, cursors, nonces, or browser fingerprint fields drift.

## Design

Store replay recipes, not just endpoints.

Each endpoint should know:

- stable shape: method, resource kind, response fields, semantic intent
- dynamic dependencies: cookies, CSRF, bearer/guest tokens, feature flags, variables, client transaction IDs, cursors
- dependency resolvers: how to get current values from browser session, bundle/init request, previous operation, or latest observed request
- volatility TTL: single-use, session, bundle hash, hourly, daily, stable

Execution should run a refresh ladder:

1. Try cached replay.
2. On auth-shaped failure, refresh browser credentials and retry once.
3. On contract-shaped failure, hydrate dynamic request fields from the latest observed request or bundle/init dependency.
4. If still stale, run a minimal browser seed for the same context URL, observe the current request, update the recipe, and retry.
5. Return failure only when browser seed also cannot produce a valid current request.

## CLI Surface

The default CLI and MCP surfaces should expose only what the agent must provide
next. Keep the source of truth in `src/agent-surface.ts` so both entrypoints
share public commands, public MCP tools, tool descriptions, input schemas,
usage text, guidance, and required-only result shape.

Normal path:

```
unbrowse run <url-or-domain> "intent" [-p key=value]
```

`run` may use resolve, execute, auth refresh, capture repair, browser seed, or cached
skills internally. CLI flags should behave like an MCP schema: only reveal the
next argument the agent must provide, at the point it is needed.

The default output should be either:

- `ok: true`, `data`, `count`, `source`, `required: []`
- `ok: false`, `status`, `required: [{ type, reason, command|fields|strategy }]`

Do not expose skill IDs, endpoint IDs, raw GraphQL variables/features, captured
request IDs, marketplace/cache distinctions, or harness/debug commands in public
help. If replay is stale, surface a public repair command such as:

```
unbrowse run <url-or-domain> "intent" --refresh
```

Do not tell normal users to call `capture`, `resolve`, or `execute` directly.

Debug/harness primitives stay callable but undiscoverable in public help:

```
unbrowse help --advanced
```

That advanced CLI surface can expose `resolve`, `execute`, `capture`, `review`,
`publish`, `test`, `validate`, and direct browser primitives for evals and repair.
For MCP, the equivalent is `UNBROWSE_MCP_DEBUG_TOOLS=1` or `--debug-tools`;
normal `tools/list` returns only `unbrowse_run`, `unbrowse_fetch`,
`unbrowse_login`, and `unbrowse_doctor`.

Hidden MCP tools should also reject direct guessed calls outside debug mode and
point back to `unbrowse_run` with structured `required` guidance. The distinction
is presentation and agent-routing, not capability removal.

## Classification

Use failure shape to pick the repair path:

- `401` / `403` before auth refresh: auth stale
- `401` / `403` after auth refresh: contract, fingerprint, or missing dependency stale
- `400`: request params/schema stale
- `404`: route or GraphQL query ID stale
- `429`: rate/policy stale
- `5xx`: service or anti-bot instability
- `200` with empty/mismatched data: cursor, fingerprint, or session-bound value stale
- timeout: strategy stale, browser replay needed, or local runtime hang

## X Search Example

The skill must not mean:

```
call /i/api/graphql/<captured-id>/SearchTimeline forever
```

It should mean:

```
search X by deriving the current SearchTimeline request from the live app/session,
then replay the current request or refresh the recipe.
```

For X specifically, treat these as dynamic:

- `x.com` and `twitter.com` cookies
- csrf/`ct0`
- bearer/guest headers
- GraphQL query ID
- `features`
- `variables`
- client transaction/fingerprint headers
- cursors

## First Implementation Slice

Implemented now:

- same-party X/Twitter cookie aliasing during browser auth extraction
- bounded CLI timeouts for long capture/execute operations
- fail-fast packaged server startup when `dist/server.js` is missing
- stale result classification with repair guidance, recapture command, and dynamic dependency hints

Next slices:

- persist endpoint volatility metadata at publish/index time
- store latest observed request as a refresh source for dynamic GraphQL replay
- auto-recapture minimal context URL on contract-shaped stale failures
- diff old/new endpoint contract and update the local skill before returning to the agent
