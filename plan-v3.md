# Plan v3: Wire SSR Fast-Path + Probe-400 + 5xx-Fallback to 100% Coverage

**Premise**: survey proved 6 specific BLOCK sites unlock via libcurl-impersonate (`.bench-history/PHASE-B-SURVEY-2026-05-08.md`). Phase A's rubric shipped. The remaining trajectory to 100% is three concrete code changes against a known list of target URLs.

**Current state**: PASS=7, PROD=2, BLOCK=22, denom=9, **coverage=77.8%**.

**Goal**: PASS=15, PROD=0, denom=15, **coverage=100%** on the existing hard-target corpus.

## What this plan replaces

`plan-v2.md` was a 5-phase exploratory plan. Phases A and B-survey are done. This plan is the executable continuation: B-wire + C + D (E/F deferred). No exploration, no decision gates — three bounded patches with measured costs.

## Phase B-wire — capture-pipeline integration of `trySsrFastPathOnBlock`

**Helper already shipped**: `src/capture/ssr-fastpath.ts` (commit `818ded94`) — 113 LoC, 12 unit tests in `tests/ssr-fastpath.test.ts`, all green.

**Current bottleneck**: helper is not called anywhere in production. The two early-return sites in `src/execution/index.ts` bypass the page_fetch invariant when capture is browser-blocked.

### Wire site #1: `low_quality_dom_extraction` early return (~line 1343)

Pre-condition: browser capture got HTML but DOM extractor rejected quality (`pageArtifact.quality_note` is set). Real example: glassdoor returned 344KB of CF "Just a moment..." page, extractor failed.

Patch:
```ts
if (pageArtifact.quality_note) {
  // NEW — try libcurl-impersonate before giving up
  const { trySsrFastPathOnBlock } = await import("../capture/ssr-fastpath.js");
  const ssr = await trySsrFastPathOnBlock({ url, seedCookies: cookies, timeoutMs: 15_000 });
  if (ssr) {
    // Override pageArtifact with libcurl-fetched HTML; clear quality gate
    pageArtifact.quality_note = undefined;
    pageArtifact.html = ssr.html;
    // Fall through to publish path at line ~1443
  } else {
    // (existing return block — preserved unchanged)
  }
}
```

### Wire site #2: `no_endpoints` early return (~line 1383)

Pre-condition: capture got 0 endpoints (e.g. anti-bot intercepted all XHRs). Real example: indeed got 283 observed_apis but 240 were `not_api_like`, 0 admitted.

Patch: same pattern — call `trySsrFastPathOnBlock` before returning. On success, synthesize a minimum skill via the existing page_fetch invariant builder + `extractEndpoints(ssr.observed_routes, ...)` to scan any XHRs the sandbox bundle saw.

### Surface area

- Files touched: `src/execution/index.ts` (2 edits, ~30 LoC each = ~60 LoC)
- New tests: extend `tests/ssr-fastpath.test.ts` with 2 integration assertions:
  - quality_note path: mock `pageArtifact.quality_note='low_quality'` + mock helper success → verify `trace.success===true` and skill published
  - no_endpoints path: mock `endpoints.length===0` + mock helper success → verify page_fetch endpoint synthesized
- Risk: low. Helper returns null on any failure (15s timeout, sandbox unavailable, body <1KB, non-2xx) → unchanged behavior.

### Coverage delta

Survey-confirmed PASS sites: indeed, ticketmaster, leboncoin, vinted, airbnb, nike → 6 sites move BLOCK → PASS. **Coverage: 7/9 → 13/15 = 87%.**

### Cost

~60 LoC + ~30 LoC test + 1 fresh bench run + commit. Estimated 90min.

## Phase C — Probe-gate extend to 4xx-with-text-html

**Current**: `src/execution/probe.ts:decideFromProbe` routes 401/403 to `server` strategy (commit `a9c0ad58`). 400 still falls into `return-error` short-circuit, synthesizing a stub.

**Target**: footlocker.com/category/men/shoes.html — HEAD probe returned 400 + `text/html`. The site likely rejects HEAD on this UA but accepts GET.

### Patch

```ts
// In decideFromProbe, AFTER the 401/403 → server branch
if (status === 400 && /text\/html/i.test(content_type)) {
  return {
    strategy: "server",
    reason: `probe status 400 + html content-type — fetch full body (HEAD may be rejected for this UA, GET often succeeds)`,
  };
}
```

### Surface area

- Files: `src/execution/probe.ts` (~5 LoC)
- Tests: extend `tests/execution-probe-ladder.test.ts` with 2 cases:
  - 400 + text/html → server strategy
  - 400 + application/json → return-error preserved (no over-trigger)

### Coverage delta

footlocker PROD → PASS (assuming GET returns real product page). **Coverage: 13/15 → 14/15 = 93%.**

### Cost

~5 LoC + 2 test cases + 1 bench re-run on footlocker only. Estimated 30min.

## Phase D — 5xx → page_fetch fallback in `executeEndpoint`

**Current**: `classifyExecuteFailure` returns `kind: "transient"` for 5xx, but the executor doesn't act on it — falls through to staleEndpointResult.

**Target**: walmart.com/search?q=coffee — captured endpoint 500s. Skill manifest contains a page_fetch synthetic (per the page_fetch invariant), but it's not being chosen on 5xx.

### Patch

In `src/execution/index.ts` near the existing `if (!trace.success && (status === 404 || status === 429 || status >= 500))` block (line ~2717):

```ts
const failureKind = classifyExecuteFailure({ status, body: rawFailureBody });
if (failureKind.kind === "transient") {
  // Try the page_fetch synthetic from the same skill before giving up
  const pageFetchEp = (skill.endpoints ?? []).find(isPageFetchEndpoint);
  if (pageFetchEp && pageFetchEp.endpoint_id !== endpoint.endpoint_id) {
    log("exec", `5xx on ${endpoint.endpoint_id}; falling back to page_fetch ${pageFetchEp.endpoint_id}`);
    // Re-execute via existing executeEndpoint path with the page_fetch ep
    return executeEndpoint(skill, pageFetchEp, params, projection, options);
  }
}
```

### Surface area

- Files: `src/execution/index.ts` (~15 LoC)
- Tests: extend `tests/classify-execute-failure.test.ts` with one integration assertion (mocked executeEndpoint recursion).
- Recursion guard: `pageFetchEp.endpoint_id !== endpoint.endpoint_id` prevents infinite loop if the failing endpoint IS the page_fetch.

### Coverage delta

walmart PROD → PASS. **Coverage: 14/15 → 15/15 = 100%.**

### Cost

~15 LoC + 1 test + bench re-run. Estimated 45min.

## Total budget

| Phase | LoC | Tests | Time | Coverage After |
|---|---|---|---|---|
| B-wire | 60 | 2 | 90min | 87% |
| C | 5 | 2 | 30min | 93% |
| D | 15 | 1 | 45min | **100%** |
| **Total** | **80** | **5** | **~3h** | **+22.2%** |

## Order

1. **D first** — smallest risk surface (single file, recursion guard, transient-only path). Validates that page_fetch fallback works mechanically before adding more.
2. **C second** — single line in probe.ts, very narrow scope.
3. **B-wire last** — highest risk (touches capture pipeline). Survey already de-risked the data path; the integration shape is what's left.

This order lets each commit be independently revertable and the bench act as the storm-test for each.

## What's NOT in this plan (deferred)

- **Phase E** (long-tail BROWSER_BLOCK sites that need bundle-replay): glassdoor, similarweb, g2, target, etsy, etc. These need Phase F.
- **Phase F** (bundle-replay challenge solver) — separate iteration. Survey proved leboncoin+vinted DON'T need it; Phase F is for actual CF/PerimeterX-resistant cases like glassdoor.
- **Auth-required sites** (instagram, tiktok, youtube) — out of scope.
- **CHANGELOG / README** — bench-only changes; no public surface affected.

## Definition of done

- 3 commits on `feat/agent-ux-run-planner`, each independently revertable.
- Full hard-target bench (31 URLs, marketplace wiped per URL) runs cleanly with `bash scripts/bench-two-phase.sh --use-source`.
- Resulting `.bench-history/<runid>/` shows coverage ≥ 90% (target 100%, tolerate 1-2 sites missing the predicted unlock if real-world conditions changed since survey).
- 8 new test assertions across `tests/ssr-fastpath.test.ts`, `tests/execution-probe-ladder.test.ts`, `tests/classify-execute-failure.test.ts`, all green.
- `.bench-history/COVERAGE-SNAPSHOT-2026-05-08.md` updated with the new tally.

## Risk + rollback

- **B-wire risk**: SSR fast-path triggers on a site where it shouldn't (e.g. a real auth-required site that returns a teaser page). Mitigated by existing `validateExtractionQuality` gate AFTER the helper returns — only publishes if extraction quality is high.
- **C risk**: 400 + html that's actually a real product validation error gets retried. Mitigated by `text/html` gate (real API errors return JSON).
- **D risk**: 5xx → page_fetch loops if page_fetch itself 5xxs. Mitigated by `endpoint_id !== endpoint.endpoint_id` recursion guard.
- **Rollback**: each phase is one commit; `git revert <sha>` per phase.
