# DAG-Recompute Replacement — Current State Snapshot

Plan: `replace-proven-recipe-replay-with-full-dag-recom`
Snapshot date: 2026-05-20
Base ref (snapshot baseline): `origin/main` @ `e584a068`
Author scope: read-only audit; no code edits in this wave.

This file is the substrate-faithful evidence layer for the multi-phase
DAG-RECOMPUTE-replaces-proven_recipe-REPLAY project. It surfaces what
EXISTS on `origin/main` today, what has SHIPPED upstream of main, and
what remains. The agent judges remaining work in-thread against this
evidence; no verdict is baked in.

---

## 1. North-star and prior shipped phases

Per `project_dag_recompute_north_star` memory: "every captured endpoint
is a typed node with requires/yields edges; resolve+execute walks the
chain and recomputes. Not flat curl caching."

### Phase 8.3 — per-host registry deletion (SHIPPED to main)

The CLAUDE.md case-study claim is verified by `git log --grep "08-03"`:

| Commit | What |
|--------|------|
| `5936c2b2` | refactor(08-03): delete deriveStructuredDataReplay registry + canonical-replay surface |
| `58108cbf` | refactor(08-03): delete EndpointDescriptor.exec_strategy field + carry-forward |
| `0f1ccf5c` | test(08-03): drop tests targeting deleted structured-replay surface |
| `963fad2d` | docs(08-03): convert per-host registry anti-pattern to deletion case study |
| `9980d87c` | docs(08): mark Phase 8 complete in roadmap |

Audit greps on `src/` (snapshot run):
- `exec_strategy` — **0 hits** in `src/` (field deleted)
- `deriveStructuredDataReplay` — **0 hits** in `src/`. Only survives in
  `CHANGELOG.md:1203` and `tests/reddit-root-fixes.test.ts:3,7,13,19`
  (the test file imports it but the symbol no longer exists in
  `src/execution/index.js`; that test file is a candidate for
  deletion or rewrite, not in scope for this wave's snapshot).

Phase 8.3 deletion **is in fact done on main**, matching the CLAUDE.md
case-study statement.

### Wave-1 spec (SHIPPED to main, docs only)

`bbbc295b docs: wave 1 spec for proven_recipe replay -> DAG recompute
(cookie-source header binding) (#573)` references
`docs/dag-recompute-wave1-cookie-recompute.md`. Specification only;
no code change.

### Wave-2 code (NOT on main; isolated session branch)

`1c6d5468 feat(execution): wave-2 DAG recompute, cookie-source header
binding` exists on branch
`session/dag-recompute-wave2-cookie-258b0b5c45470b6c` ONLY. Verified
via `git branch -a --contains 1c6d5468` and
`git log origin/main --grep "wave-2 DAG recompute"` (empty). The
commit adds:

- `detectCookieHeaderBindings()` (structural primitive:
  header_value === cookie_value)
- `HeaderBinding` discriminated union (`source.kind` in
  `cookie | provides | storage | computed_by`) on `ProvenRecipe`
- `replayRecipe` overwrite-or-delete loop for `cookie`-kind bindings
- `decision_trace_steps: [{step: "header_binding_recompute", ...}]`
- 3 new passing tests in `tests/recipe-replay-cookie-recompute.test.ts`

Only `cookie` is implemented. `provides`, `storage`, `computed_by`
are typed placeholders for waves 3 through 5.

---

## 2. `proven_recipe` REPLAY code paths still present on `origin/main`

`zigrep proven_recipe src/` returns **9 hits across 3 files**
(snapshot):

### 2.1 `src/types/skill.ts`

| Line | Surface | Status |
|------|---------|--------|
| L262 to L264 | `EndpointDescriptor.proven_recipe?: ProvenRecipe` field, Phase 7.2 stamp | SHIPPED, still in use |
| L299 to L331 | `ProvenRecipeResponseSignal` + `ProvenRecipe` interface declarations (method, url_template, headers, body, response_signal, captured_at) | SHIPPED, still in use |

Wave-2 will ADD `header_bindings?: HeaderBinding[]` to this interface.
Currently absent on main.

### 2.2 `src/reverse-engineer/index.ts`, capture side

| Line | Surface | Status |
|------|---------|--------|
| L1199 to L1205 | `buildProvenRecipe(req, computedUrlTemplate)` is stamped onto every admitted endpoint (skipped on non-2xx, missing body, or `synthetic_body`) | SHIPPED, frozen-headers behaviour |
| L1553 to L1557 | `buildProvenRecipe()` definition, Phase 7.2 builder | SHIPPED, frozen-headers behaviour |
| L1027 | Comment referencing `proven_recipe` + `verification_status` interaction | SHIPPED |

Wave-2 (`session/dag-recompute-wave2-cookie-...`) adds
`detectCookieHeaderBindings()` here and threads its output into the
emitted ProvenRecipe. **Not yet on main.**

### 2.3 `src/execution/index.ts`, execute side

| Line | Surface | Status |
|------|---------|--------|
| L26 | Imports `ProvenRecipe`, `ProvenRecipeResponseSignal` from types | SHIPPED |
| L3290 to L3334 | Recipe replay FAST PATH, runs BEFORE probe ladder. Calls `shouldReplayRecipe` then `replayRecipe` then `matchResponseSignal`. On match, sets `workflowChosenStrategy = "recipe-replay"` and short-circuits. On miss, falls through to probe. | SHIPPED, this is the path that frozen-replays captured headers |
| L4811 to L4813 | `shouldReplayRecipe()`, generic placeholder-presence guard | SHIPPED |
| L4820 to L4865 | `replayRecipe()`, fetches with `headers = { ...recipe.headers, ...authHeaders }`. **No live recompute of cookie-bound headers; emits frozen `recipe.headers` verbatim.** | SHIPPED, the frozen replay site wave-2 patches |
| L4875 to L4900+ | `matchResponseSignal()`, strict-status, tolerant byte-window + json_top_keys comparison | SHIPPED |

### 2.4 `src/execution/recipe-replay-hints.ts`

| Line | Surface | Status |
|------|---------|--------|
| L1 to L74 | `deriveRecipeReplayNextStep(reason, context)`, agent-readable next_step strings dispatched on `matchResponseSignal` reason prefixes (`status_changed`, `missing_top_keys`, `body_shrunk`, `body_grew`, `signal-mismatch`, `status-mismatch`, `recipe-missing-field`, unknown/default) | SHIPPED |

Hint generator surfaces evidence to the agent on replay miss, does NOT
encode a verdict. Keep as-is regardless of replay/recompute fate.

### 2.5 `src/workflow/`

`zigrep proven_recipe src/workflow/` returns **0 hits**. The DAG
walker (`workflow/compile.ts`, `workflow/runtime.ts`,
`workflow/publish.ts`, `workflow/artifact.ts`) does not directly
reference `proven_recipe`. Wave-2 and later will add typed edges
(`token_source`, `cookie_source`, `storage_source`, `computed_by`)
which compile-side may surface.

---

## 3. Edge types referenced by the plan vs. what exists on main

Plan declares typed edges: `token_source`, `cookie_source`,
`storage_source`, `computed_by(bundle_fn_ref, input_requires)`.

`zigrep "cookie_source|token_source|storage_source|computed_by" src/`
returns **0 hits on main.** None of these edge kinds exist yet on
`origin/main`. Wave-2 introduces `cookie` as the first kind on its
session branch.

---

## 4. Remaining-work list (agent judges priority in-thread)

1. **Land wave-2 to main.** `1c6d5468` currently isolated on
   `session/dag-recompute-wave2-cookie-...`. Needs PR + merge to
   origin/main so the first DAG-recompute edge type (`cookie`) is
   live for downstream waves to build on.
2. **Wave 3, provides-edge recompute.** Resolve `header_bindings`
   with `source.kind = "provides"` by walking `operation_graph` to a
   producer op and re-fetching fresh at execute time. Requires the
   chain-walk executor (already present at L3336 to L3356 referencing
   `_chain_walk_active`) to be wired into `replayRecipe`.
3. **Wave 4, storage-source recompute.** Read live localStorage and
   sessionStorage at execute time via Kuri/CDP for header bindings.
4. **Wave 5, computed_by recompute.** Extract pure JS-bundle function
   from captured page, execute in isolation with typed
   `input_requires`. Highest-complexity wave (function extraction,
   not full replay).
5. **Deepen provides extraction.** Current `provides` capture is
   shallow (`__typename`). Plan requires capturing yielded auth/CSRF/
   computed values so waves 3+ have edges to walk.
6. **executeSkill fail-loud surface.** When a required binding has no
   recompute source, raise with candidate-source evidence, never
   silently emit the frozen captured header. Wave-2 starts this for
   the cookie case (deletes the header if live cookie absent); needs
   to generalize across all binding kinds.
7. **Demote `proven_recipe` to a response_signal staleness check
   only.** Once every header and param has a typed recompute source,
   `recipe.headers` becomes redundant and can be dropped; the
   `response_signal` remains useful as a fingerprint validator.
8. **Recompute-trace probe.** Bench probe asserting zero
   `proven_recipe` frozen-replay executions on figma + CSRF-from-
   cookie + response-minted-token corpora. Lives in the bench-gate
   corpus, not the substrate.
9. **Test-file cleanup.** `tests/reddit-root-fixes.test.ts` imports
   `deriveStructuredDataReplayCandidates` and
   `deriveStructuredDataReplayUrl` which no longer exist in
   `src/execution/index.js` (Phase 8.3 deletion). Either rewrite or
   delete the test. Not in this wave's scope but worth surfacing.

---

## 5. What this wave does NOT claim

- This snapshot does NOT advance the project to "converged". Wave-2
  is unmerged; waves 3 through 5 are unstarted; provides-extraction
  is still shallow.
- This snapshot does NOT bake a verdict or numbered next-step
  procedure. The remaining-work list above is evidence, not a
  prescribed sequence; the agent judges what to ship next.
- This snapshot does NOT touch any `src/` code. It is a read-only
  audit + ledger row.

---

## 6. Falsifier commands

```
zigrep "proven_recipe" src/                # 9 hits expected (this wave's baseline)
zigrep "exec_strategy" src/                # 0 hits (Phase 8.3 verified)
zigrep "deriveStructuredDataReplay" src/   # 0 hits (Phase 8.3 verified)
zigrep "cookie_source|token_source|storage_source|computed_by" src/   # 0 hits on main
zigrep "HeaderBinding|header_bindings" src/  # 0 hits on main; non-zero on wave-2 session branch
git branch -a --contains 1c6d5468          # confirms wave-2 isolated to session branch
git log origin/main --grep "wave-2 DAG recompute" --oneline   # empty (not on main)
```

If any of the "0 hits" assertions become non-zero on `origin/main`
without an accompanying snapshot update, the snapshot is stale and
must be refreshed before the next wave decides scope.
