# Wave 1 — Cookie-binding recompute (smallest scope toward DAG-recompute north star)

Status: SPEC ONLY (iter 1). Wave 1 ship target. Scaffold previously had iters=0,
no prior wave work landed. This doc maps the existing frozen-replay call sites
and declares the smallest typed binding (`cookie`) to convert to a recompute
SOURCE first.

## North star (from plan_text)

Replace `proven_recipe` REPLAY (frozen-header replay) with full DAG RECOMPUTE.
Every required header/param/token/cookie resolves at execute time by walking
`operation_graph` to a recompute SOURCE: (a) live cookie/localStorage/
sessionStorage read, (b) provides-edge from another op response, (c) extracted
pure JS-bundle function. LAW: never emit or execute a frozen-header/frozen-
request replay.

## Existing replay call sites (cited)

All three live call sites that EMIT a frozen `proven_recipe.headers` request:

1. `src/execution/index.ts:3308` — primary executor fast-path
   ```ts
   if (endpoint.proven_recipe && shouldReplayRecipe(endpoint.proven_recipe, url)) {
     const recipeResult = await replayRecipe(endpoint.proven_recipe, url, cookies, authHeaders, mergedParams);
     ...
   ```
2. `src/orchestrator/resolve-race.ts:271` — racer 1, recipe replay racer in resolve
3. `src/orchestrator/resolve-race.ts:410` — secondary recipe-replay candidate scan

`replayRecipe` itself lives at `src/execution/index.ts:4820`. It does:

```ts
const headers: Record<string, string> = { ...recipe.headers, ...authHeaders };
if (cookies.length > 0) {
  headers["cookie"] = cookies
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}
```

`recipe.headers` is the FROZEN capture-time header bag. The function does
already overwrite the literal `Cookie:` header with live cookies — so
unstructured `cookie:` is partially live already. But `recipe.headers` can
ALSO carry header tokens derived FROM a cookie at capture time, e.g.
`x-csrf-token: <csrf-value-at-capture>`. Those stay frozen across replay.

This is the bug for cookie-rotating sites (Figma, Notion, X, Discord):
the cookie header rotates live, but the `x-csrf-token` (or `x-xsrf-token`,
`x-csrftoken`, `_csrf`, `authenticity_token`) header in `recipe.headers`
is the CAPTURE-TIME value of the cookie, not the current one. Replay
sends a mismatched pair (live cookie A + stale CSRF derived from cookie A')
and the server rejects.

## Wave 1 scope (the ONE binding type we convert)

Cookie-derived CSRF/XSRF-style request headers. Specifically: any header in
`recipe.headers` whose value at capture time equals the value of a cookie
captured in the same session. At replay time, recompute that header by
reading the LIVE cookie value with the same name and substituting it into
the header — never emit the frozen value.

Concretely: extend `replayRecipe` (and the capture-side `buildProvenRecipe`
that stamps `proven_recipe.headers`) to:

1. **Capture-side (`buildProvenRecipe` in `src/reverse-engineer/index.ts`):**
   For every header in the captured request, compare its value against the
   cookie jar captured with the same request. If header value === cookie
   value, record a typed binding (NOT a string) describing the cookie
   source. Stash as a new field, e.g. `proven_recipe.header_bindings:
   Array<{header: string; source: {kind: "cookie"; cookie_name: string}}>`.

2. **Execute-side (`replayRecipe` in `src/execution/index.ts`):**
   Before emitting the request, walk `header_bindings`. For each binding
   with `source.kind === "cookie"`, look up the LIVE cookie value by name
   and overwrite `headers[binding.header]` with it. Emit `decision_trace`
   row `{step: "header_binding_recompute", header, source: "cookie:<name>",
   live_value_present: bool}` so the agent can see the recompute.

3. **Fail loud:** if a binding declares cookie source but the cookie is
   absent in the live jar, do NOT emit the frozen header. Surface the
   missing-cookie candidate as evidence (next_step with the candidate
   cookie name) and return the recipe miss so the probe ladder takes
   over. This is the "FAILS LOUD with surfaced candidate-source evidence
   when irreducible" rule from the plan_text.

This is the minimal cookie_source edge type the plan_text calls for, in
one binding direction (cookie → header), at the smallest blast radius.

Token-from-response (provides-edge walk) and storage_source/computed_by
edges stay out of wave 1. Wave 2 picks up `header_bindings` where the
source is a previous response body (token-mint endpoints).

## Falsifying test (write BEFORE implementing)

`tests/recipe-replay-cookie-recompute.test.ts` — must fail on main:

```ts
// 1. Build a proven_recipe whose headers include
//    `x-csrf-token: CAPTURE_TIME_CSRF` AND a cookie jar where
//    `csrf=CAPTURE_TIME_CSRF` was the live cookie at capture.
// 2. Build header_bindings declaring x-csrf-token ← cookie "csrf".
// 3. Call replayRecipe with a NEW cookies array where
//    csrf=LIVE_ROTATED_CSRF (different from capture).
// 4. Stub fetch and capture the outgoing headers.
// 5. Assert outgoing `x-csrf-token === LIVE_ROTATED_CSRF`,
//    NOT CAPTURE_TIME_CSRF.
// 6. Assert decision_trace has a `header_binding_recompute` row.
```

Mutation falsifier: temporarily revert the recompute branch and confirm
the test FAILS (outgoing header is the frozen value). Restore and confirm
PASS. This is the "mutation-test every xfail before commit" rule from
project memory (`feedback_xfail_mutation_test`).

## Out of scope (wave 2+)

- `provides`-edge token recompute (response body → request header) — wave 2.
- `computed_by` bundle-function extraction + isolated execution — wave 3.
- `storage_source` (localStorage/sessionStorage) — wave 4.
- Demoting `proven_recipe` to a response_signal staleness check only —
  final wave, once all 4 binding types are recompute-driven.
- `resolve-race.ts:271` + `:410` call sites — wave 1 only touches the
  execution-side replay. The resolve-side racers stay frozen this wave;
  they call the same `replayRecipe` so wave 1 changes already reach them
  through that path, but the agent should NOT add cookie-source plumbing
  in resolve-race.ts until execute side is proven green.

## Why this is the smallest first wave

- One typed binding (cookie), not a registry.
- One direction (cookie → header), not the full DAG.
- Touches one capture function + one execute function + one new field
  on `ProvenRecipe`. Three files, ~80 LOC, one test.
- Cookie-rotated sites are the most-observed failure mode for replay
  staleness (CITED in plan_text: figma w3bIuIAfygHXF4KUXS8pt skill).
- Generic primitive (header_value === cookie_value), no per-domain arm,
  no banned list, no prose template — satisfies the substrate principle.

## Falsifier-borrowed gates (when wave 1 PR opens)

- `tsc --noEmit` clean on src/
- `bun test tests/recipe-replay-cookie-recompute.test.ts` green
- `bun test tests/execution-recipe-replay.test.ts` still green
  (no behavioral regression on the existing replay surface)
- Substrate-audit: zero new host-branch lines, zero prose templates,
  zero hardcoded cookie-name aliases
