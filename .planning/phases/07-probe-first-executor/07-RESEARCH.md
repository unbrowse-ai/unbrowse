---
phase: 07
title: Probe-First Executor + Recipe Replay
goal: Replace cached-strategy switch with probe→choose→execute→record ladder; surface decision_trace on every response
---

# Phase 07 Research

## Why this phase exists

Today's executor (`src/execution/index.ts:2750-2900`) is a 200-line switch over four predicted strategies (`hasStructuredReplay` / `endpointStrategy === "server"` / `"trigger-intercept"` / `"browser"` / `else`). The strategy is **predicted from a cached `endpoint.exec_strategy` field** that was learned on a single past execution. The switch then dispatches to one of three execution functions: `serverFetch`, `triggerAndIntercept`, or `executeInBrowser`.

This is the same anti-pattern the `Ranker philosophy` section of CLAUDE.md bans for ranking — except here it lives in the executor.

### Concrete failure caught by harness/recursive

Reddit `https://www.reddit.com/r/programming/comments/1lnzjz3/announcing_zig_v0_15_0/.json`:

| Step | What happened | What should have happened |
|---|---|---|
| 1 | Cached `exec_strategy=null` (or "trigger-intercept" learned from a flaky earlier run) | — |
| 2 | Switch dispatched to `triggerAndIntercept` → opened a kuri tab, navigated, waited 15s for an outgoing request matching the URL | Probe the URL with HEAD first |
| 3 | No outgoing request fires because the page IS the response — JSON returned by direct GET | HEAD returns 200/404 + `application/json` in <500ms |
| 4 | Returns `status: 0, error: "trigger_timeout"` after 15s | Returns the actual server status (200/404) immediately |
| 5 | Patch attempts in v6.2.5 / v6.2.6 added 4-deep fallback in 3 code paths. Still failed in production (couldn't determine which path executed without stderr capture) | Decision is observable from the response — no fallback layers needed |

Three lessons:

1. **Prediction-from-cache is structurally wrong.** Sites change behavior, the cache is stale, and learned strategies trap future calls in a path that can never succeed.
2. **15s of silence is worse than a 4xx.** Reddit returning 404 is actionable; `trigger_timeout` is not.
3. **No observability == no fix.** Even when the fix is present in source, you can't verify it ran without `decision_trace` on the response.

## First-principles analysis

A reverse-engineer at devtools doesn't need to predict — they probe. One HEAD request is a tiny structural primitive that tells you everything:

| HEAD result | Strategy implied | Evidence used |
|---|---|---|
| 200 + `content-type: application/json` | `serverFetch` | Direct GET will return JSON |
| 200 + `content-type: text/html` + < 5KB body | `triggerAndIntercept` (SPA shell) | Page needs JS to render data |
| 200 + `text/html` + ≥ 5KB body | `serverFetch` + `extractFromDOM` | Server-rendered HTML, scrape it |
| 401/403/429 | Return immediately with the status | Auth/rate problem; agent decides |
| 405 (HEAD not allowed) | Fall through to 1-byte ranged GET | Some servers reject HEAD |
| Connection failed/DNS/TLS | Return network error | Not our bug to retry |

The probe is structural evidence. Strategy is **derived** from the evidence, not predicted from a cached label. This matches the `Ranker philosophy` model: structural primitives + deterministic mapping.

### The `triggerAndIntercept` branch becomes rare

Today: strategy predicts trigger-intercept far more often than needed (any captured endpoint with a `trigger_url` field is eligible).
After: trigger-intercept fires only when the probe says "no direct response" — the page truly does need a navigation to trigger the API. Twitter `HomeTimeline` qualifies. Reddit `/comments/{id}/.json` does not.

### Recipe replay subsumes most strategy work

When admission stored an endpoint, we KNEW it worked — that's how we got the response in the first place. Today we throw that ground truth away and re-derive at execute time. The fix: persist a `proven_recipe` at admission:

```ts
proven_recipe: {
  method: "GET",
  url_template: "...",          // for entity substitution
  headers: { ... },             // exact headers that produced 200
  body: "...",                  // exact body for POST
  response_signal: {            // how we know replay succeeded
    status: 200,
    content_type: "application/json",
    byte_length_range: [1024, 2048000],
    json_keys?: ["data", "children"]
  },
  captured_at: "2026-04-30T..."
}
```

Replay = send the recipe, compare `response_signal`. Match → done in <1s. Miss → escalate to discovery (probe ladder). No strategy guessing.

### Observability is the unblocker

`decision_trace` on every response makes today's debugging session impossible to recur:

```json
{
  "decision_trace": [
    {"step": "recipe_replay", "method": "GET", "status": 200, "match": true, "ms": 187},
  ],
  "result": [...]
}
```

Or for the hard case:

```json
{
  "decision_trace": [
    {"step": "recipe_replay", "status": 404, "match": false, "reason": "status_changed", "ms": 134},
    {"step": "probe", "method": "HEAD", "status": 404, "content_type": "application/json", "ms": 87},
    {"step": "decision", "kept": "server", "reason": "self-fetchable, status known"},
  ],
  "result": {"error": "Not Found", "message": "404"}
}
```

Agents read `decision_trace` to self-correct. The harness reads it to judge what went wrong without needing to instrument the binary.

## Existing executor branches → new ladder

| Old branch (line range) | New mapping |
|---|---|
| `hasStructuredReplay` (2756-2782) | Recipe replay step (the per-host `deriveStructuredDataReplay` registry is removed; recipes carry the substituted URL) |
| `endpointStrategy === "server"` (2783-2793) | Recipe replay → if signal matches, return; else probe |
| `endpointStrategy === "trigger-intercept"` (2794-2839) | Probe step → only `triggerAndIntercept` if probe says "no direct response" |
| `endpointStrategy === "browser"` (2839-2857) | Probe step → only browser if probe is 200 + html-shell + intent needs DOM |
| `else` no-strategy (2857-2904) | Probe-first ladder (this becomes the only entry path for first-time endpoints) |

The deprecated per-host registry in `deriveStructuredDataReplay` (mastodon/gitlab/github/hn.algolia/huggingface/mdn) goes away — its 6 site arms are all "if you see this URL, transform to that URL". Recipe replay does the same thing generically: when admission saw `/search?q=foo` produce `/api/v2/search?q=foo`, that mapping is the recipe.

## Migration path

1. **Phase 7.1 — probe-first executor (no schema change):** Build `probe(url, headers, cookies)` primitive. Wire it as the first step of the new ladder. Keep recipe-replay-by-default for endpoints that have `exec_strategy` set; treat it as a recipe with `response_signal: {status: 2xx}`. Remove `triggerAndIntercept` from any path that isn't probe-said-yes.
2. **Phase 7.2 — proven_recipe + decision_trace (additive schema):** Add `proven_recipe?: ProvenRecipe` to `EndpointDescriptor`. Capture pipeline stamps it at admission. Executor reads it before probing. `decision_trace` joins the response shape (additive — old clients ignore it).
3. **Phase 7.3 — cleanup (deferred to Phase 8 if desired):** Delete `exec_strategy` field, delete `deriveStructuredDataReplay` and its 6 site arms, delete the strategy-prediction switch.

Migration is non-breaking through 7.1 + 7.2. Only 7.3 deletes existing fields.

## Open questions

- **HEAD reliability across hosts.** Some sites (Cloudflare-fronted) reject HEAD. The `405 → ranged GET` fallback handles this. But ranged GETs themselves can be rejected. Worst case: full GET, 1MB cap, treat as the probe and skip the second fetch.
- **Cookie-laden HEAD vs anonymous HEAD.** Cookies should always be included — the probe needs to see the same response the agent will see. (Today's auth-aware execution already injects cookies for serverFetch.)
- **Recipe drift detection.** When `response_signal` mismatches by a small delta (status 200→200, content_type same, byte_length within range), recipe still hits. When mismatch is structural (status 200→403, content_type changed), recipe misses → re-discover. Threshold needs tuning by bench-local.

## Out of scope

- The `triggerAndIntercept` implementation in `src/capture/index.ts:1898` stays as-is. Phase 7 only changes WHO calls it, not how it works.
- No changes to capture pipeline beyond stamping `proven_recipe` at admission (Phase 7.2).
- No changes to ranker (separate concern).
- No removal of browser-execute path — it's still the right answer for SPAs that need rendering.
