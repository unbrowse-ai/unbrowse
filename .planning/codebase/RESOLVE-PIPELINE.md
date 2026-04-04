# Resolve Pipeline Architecture

**Analysis Date:** 2026-04-02

## Overview

The resolve pipeline lives in `src/orchestrator/index.ts`, function `resolveAndExecute` (L1895-L3809). It is a ~1900-line async function that attempts to satisfy a natural-language intent by checking increasingly expensive sources: in-memory caches, local disk snapshots, marketplace search, direct fetch, first-pass browser, browse session handoff, and full live browser capture. The function is the single entry point for all intent resolution -- called from the CLI (`unbrowse resolve`), the HTTP API (`POST /v1/intent/resolve`), and the Browser API (`page.goto()`).

---

## 1. Resolve Execution Order (Step by Step)

### Phase 0: Setup (L1895-L2244)
- **L1902-1917**: Initialize timing object, decision trace
- **L1925-1926**: Compute `queryIntent` -- strip boilerplate from intent for search terms
- **L1934**: Check if agent explicitly chose an `endpoint_id` (`agentChoseEndpoint`)
- **L1936-1950**: If `force_capture`, clear all caches for the target domain
- **L1952-2051**: Define `finalize()` helper (metrics, lifecycle attribution, telemetry)
- **L2053-2151**: Define `buildDeferralWithAutoExec()` and `buildDeferral()` helpers
- **L2211-2224**: Merge URL query params into `resolvedParams`
- **L2226-2244**: Retrieve prior execution traces for RAG signal (`priorSuccessEndpoints`)

### Phase 1: Route Result Cache (L2775-2807) -- ~0ms
- **L2781**: Check `routeResultCache` (in-memory Map, 24h TTL)
- Returns full cached result (data + trace) if valid
- **Blocking**: No, immediate Map lookup
- **Timeout**: None needed

### Phase 2: Route Cache (skill route) (L2809-2858) -- 0-2.5s
- **L2811-2834**: Check `skillRouteCache` (in-memory Map persisted to `~/.unbrowse/route-cache.json`, 24h TTL)
- For each hit, loads skill from local snapshot OR marketplace (`getSkillWithTimeout`, 2.5s default)
- Validates with `isCachedSkillRelevantForIntent`
- **L2835-2858**: Pick best cached candidate, attempt auto-exec via `buildDeferralWithAutoExec`
- If autoexec fails all endpoints, invalidate and fall through
- **Blocking**: `getSkillWithTimeout` awaits up to 2.5s per skill
- **Timeout**: `MARKETPLACE_GET_SKILL_TIMEOUT_MS` (default 2500ms)

### Phase 3: Domain-Level Cache (L2861-2900) -- 0-2.5s
- **L2863-2886**: Check `domainSkillCache` (in-memory Map, 7-day TTL)
- Different intent, same domain -- reuse skill with new params
- **L2888-2900**: Check local disk snapshots via `findBestLocalDomainSnapshot`
- **Blocking**: `getSkill()` for marketplace hydration (up to 2.5s)
- **Timeout**: Inherits `MARKETPLACE_GET_SKILL_TIMEOUT_MS`

### Phase 3.5: Agent-Chosen Endpoint Path (L2903-2971) -- varies
- Only entered when `agentChoseEndpoint` is true (agent already picked)
- Checks route cache and executes directly
- **Blocking**: `executeSkill()` -- no explicit timeout on execution itself

### Phase 3.7: Default Local Snapshot (L2973-2993)
- Second pass at `findBestLocalDomainSnapshot` for non-agent-chosen cases
- Same logic as Phase 3 snapshot check but with broader matching

### Phase 4: Fast Path -- Skip Marketplace, Go to Browser (L2995-3096) -- 8-16s
**Condition**: `context.url` exists AND no local cache hit AND not `agentChoseEndpoint` AND not `forceCapture`

This is the NEW fast path (skips marketplace entirely when URL is available):

- **L3003-3014**: Fire-and-forget marketplace search in background (populates cache for next time)
- **L3017-3047**: `tryFirstPassBrowserAction()` -- 8s hard timeout
  - Opens Kuri tab, navigates to URL, performs intent-driven action (search/click)
  - Collects HAR entries, filters for JSON API responses
  - On HIT: returns `first-pass` result with miniSkill
  - On MISS: keeps tab alive for browse session handoff
- **L3050-3095**: Browse session handoff
  - Injects cookies from user's Chrome/Firefox via `extractBrowserCookies`
  - Injects `INTERCEPTOR_SCRIPT` for fetch/XHR capture
  - Starts HAR recording
  - Registers session via `registerBrowseSession`
  - Returns `{ status: "browse_session_open", next_step: "unbrowse snap" }`
  - Agent drives the browser; all traffic passively indexed
- **Blocking**: `tryFirstPassBrowserAction` blocks for up to 8s
- **Timeout**: Hard 8s deadline in first-pass action

### Phase 5: Marketplace Search (L3098-3269) -- 5-30s
**Condition**: Only reached if no local cache AND no fast-path hit (or no URL)

- **L3101**: Timeout is 5s when URL available, 30s without URL
- **L3107-3124**: `searchIntentResolve()` with `Promise.race` timeout
- **L3130-3140**: Dedup candidates by skill_id+endpoint_id
- **L3149-3157**: Hydrate skills in parallel (`getSkillWithTimeout`, 2.5s each, max 4 skills)
- **L3161-3181**: Score and rank candidates via `computeCompositeScore`
- **L3184-3268**: If viable candidates found:
  - Agent chose endpoint: race top 3 candidates with 30s per-candidate timeout
  - No endpoint chosen: `buildDeferralWithAutoExec` on best skill
- **Blocking**: `searchIntentResolve` (up to 5s/30s), `getSkillWithTimeout` (up to 2.5s x 4)
- **Timeout**: `MARKETPLACE_TIMEOUT_MS` (5s with URL, 30s without)

### Phase 5.5: Direct JSON Fetch (L3271-3305) -- 0-5s
**Condition**: URL looks like a raw API endpoint (contains `/api/`, `.json`, `/v1/`, etc.)

- Direct `fetch()` with 5s `AbortSignal.timeout`
- If response is JSON, return immediately
- **Blocking**: HTTP fetch, up to 5s
- **Timeout**: 5s via AbortSignal

### Phase 6: Second First-Pass Browser (L3307-3404) -- 8-16s
**Condition**: URL available AND not `forceCapture` (reached when fast path was skipped)

- Same logic as Phase 4's first-pass + browse session handoff
- Only reached when marketplace was tried first and failed
- **Blocking**: 8s first-pass + session setup
- **Timeout**: 8s hard deadline

### Phase 7: Live Browser Capture (L3406-3809) -- 10-120s
**The last resort**. Opens full browser, captures all traffic, reverse-engineers endpoints.

- **L3407-3411**: Throw if no `context.url` (dead end without URL)
- **L3416-3462**: Check `capturedDomainCache` (post-capture in-memory cache, 5min TTL)
- **L3464-3517**: In-flight capture queue
  - `captureInFlight` Map prevents duplicate captures for same domain
  - Waiting callers block on the same promise
- **L3519-3571**: Execute live capture
  - `withDomainCaptureLock` serializes per-domain
  - `withAbortableOpTimeout` wraps with `LIVE_CAPTURE_TIMEOUT_MS` (default 120s)
  - Calls `executeSkill(browserCaptureSkill, ...)` which runs the full browser capture
- **L3576-3640**: Post-capture validation
  - Check if learned skill has usable endpoints
  - Check if endpoints are relevant for the intent
  - Try local snapshot fallback if learned skill is irrelevant
- **L3642-3659**: Stamp discovery cost, generate local descriptions
- **L3677-3741**: Handle failures, DOM-extracted results, direct returns
- **L3743-3809**: Final auto-exec attempt or deferral
- **Blocking**: `executeSkill` for browser capture -- the big one
- **Timeout**: `LIVE_CAPTURE_TIMEOUT_MS` (default 120000ms = 2 minutes)
- **NO timeout on**: `withDomainCaptureLock` waiting for a prior capture to finish

---

## 2. Blocking Points and Timeouts

### Explicit Timeouts

| Operation | Default | Env Var | Location |
|-----------|---------|---------|----------|
| First-pass browser action | 8s hard | None (hardcoded) | `src/orchestrator/first-pass-action.ts` L143 |
| Marketplace `getSkill` | 2.5s | `UNBROWSE_MARKETPLACE_GET_SKILL_TIMEOUT_MS` | L226, L558-564 |
| Marketplace search (with URL) | 5s | None (hardcoded) | L3101 |
| Marketplace search (no URL) | 30s | None (hardcoded) | L3101 |
| LLM judge calls (`callJsonAgent`) | 8s | None (hardcoded) | L1457 |
| Direct JSON fetch | 5s | None (hardcoded) | L3282 |
| Live capture execution | 120s | `UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS` | L42, L3524/3544 |
| Agent-chosen endpoint race | 30s | None (hardcoded) | L3216 |

### No-Timeout Blocking Points (Infinite Hang Risk)

1. **`withDomainCaptureLock` (L896-916)**: Waits for a prior capture on the same domain to complete. If the prior capture hangs (e.g., browser deadlock), this waits forever. There is NO timeout on the lock acquisition itself.

2. **`executeSkill()` calls in auto-exec loop (L2537-2551)**: Each endpoint execution has no individual timeout. The loop tries up to 5 endpoints sequentially. Each could hang on a network request that doesn't resolve.

3. **`buildDeferralWithAutoExec` internally calls `tryAutoExecute` (L2252-2773)**: This runs LLM judge calls (`agentSelectEndpoint` at L2470, `agentJudgeExecution` at L2602) plus actual endpoint execution. No aggregate timeout on the whole auto-exec sequence.

4. **`resolveAuthPrerequisites` (L2443)**: Auth resolution (cookie extraction, profile loading) has no timeout.

5. **`inferParamsFromIntent` (L2529-2536)**: LLM call to infer template params. Has 8s timeout via `callJsonAgent`, but if the LLM provider is slow, it blocks.

6. **`fetchDagAdvisoryPlan` (L2420-2433)**: Backend advisory call. No explicit timeout visible in the orchestrator.

### Cumulative Worst Case

In the absolute worst case, a single `resolveAndExecute` call traverses:
- Route cache check + skill hydration: 2.5s
- Domain cache check + skill hydration: 2.5s
- Marketplace search: 30s (no URL)
- Skill hydration (4 parallel): 2.5s
- Auto-exec loop (5 endpoints x LLM judge): 5 x 8s = 40s
- Live capture (if auto-exec fails): 120s
- Total theoretical worst: **~197s**

With URL (more common):
- Route/domain cache: 2.5s
- First-pass browser: 8s
- Marketplace (background): 0s blocking
- Browse session handoff: ~2s
- Total fast-path: **~12s to browse_session_open**

---

## 3. Browser Primitives

### `go` (navigate)
- **CLI**: `unbrowse go <url>` -> `cmdGo` at `src/cli.ts` L822-826
- **API**: `POST /v1/browse/go` -> `src/api/routes.ts` L730-779
- **Flow**:
  1. Get or create browse session (`getOrCreateBrowseSession`)
  2. Flush prior HAR entries, run `passiveIndexHar` on old page
  3. Save auth profile for old domain (`kuri.authProfileSave`)
  4. Load auth profile for new domain (`kuri.authProfileLoad`)
  5. Inject cookies from user's Chrome/Firefox SQLite DB
  6. Enable network, start HAR, inject `INTERCEPTOR_SCRIPT`
  7. Navigate via `kuri.navigate`
  8. Re-inject interceptor for new page context

### `snap` (accessibility snapshot)
- **CLI**: `unbrowse snap [--filter interactive]` -> `cmdSnap` at `src/cli.ts` L828-836
- **API**: `POST /v1/browse/snap` -> `src/api/routes.ts` L782-788
- **Flow**: Calls `kuri.snapshot(tabId, filter)`, returns a11y tree with stable `@eN` refs

### `click` (click element by ref)
- **CLI**: `unbrowse click <ref>` -> `cmdClick` at `src/cli.ts` L838-842
- **API**: `POST /v1/browse/click` -> `src/api/routes.ts` L790-797
- **Flow**: Calls `kuri.click(tabId, ref)` using the ref from a prior `snap`

### `fill` (fill input by ref)
- **CLI**: `unbrowse fill <ref> <value>` -> `cmdFill` at `src/cli.ts` L844-849
- **API**: `POST /v1/browse/fill` -> `src/api/routes.ts` L799-806
- **Flow**: Calls `kuri.fill(tabId, ref, value)`

### `close` (close session, trigger indexing)
- **CLI**: `unbrowse close` -> `cmdClose` at `src/cli.ts` L915-917
- **API**: `POST /v1/browse/close` -> `src/api/routes.ts` L894-1005
- **Flow -- this is where passive indexing happens**:
  1. Save auth profile for current domain (`kuri.authProfileSave`)
  2. Collect intercepted fetch/XHR via `collectInterceptedRequests(tabId)` -- has response bodies HAR misses
  3. Collect HAR entries via `kuri.harStop(tabId)`
  4. **Merge**: intercepted requests (priority) + HAR entries, deduped by `method:url`
  5. **Synchronous quick-cache**: Extract endpoints immediately, merge with existing domain skill, write snapshot to disk, update `domainSkillCache`, `cachePublishedSkill`, invalidate stale route cache
  6. **Async enrichment pipeline**: `passiveIndexFromRequests` fires in background:
     - `extractEndpoints` -> `extractAuthHeaders` -> `storeCredential`
     - `mergeEndpoints` with existing skill
     - `generateLocalDescription` for each endpoint
     - `buildSkillOperationGraph`
     - `cachePublishedSkill` (local) + `queueBackgroundIndex` (marketplace publish)
  7. Close tab via `kuri.closeTab`

### Browser API (`src/browser/index.ts`)
The `Page` class wraps Kuri with skill-first resolution:
- **`page.goto(url)`** (L176-261): Calls `resolveAndExecute` first. On success, returns structured data without browser. On failure, falls through to Kuri navigation with passive HAR recording.
- **`page.close()`** (L553-574): Saves auth profile, stops HAR, calls `passiveIndexHar`, closes tab.
- HAR recording starts automatically in the `Page` constructor (L157-159).

---

## 4. Connection Between Resolve and Browser

### When Does `resolve` Open a Browser?

1. **Fast Path (Phase 4, L2995-3096)**: When `context.url` exists but no local cache. Calls `tryFirstPassBrowserAction` which opens a Kuri tab and navigates.

2. **Phase 6 (L3307-3404)**: After marketplace search fails. Same first-pass + browse session logic.

3. **Phase 7 (L3519-3571)**: Full live capture. `executeSkill` with `browser-capture` type launches a full browser capture session via `src/execution/index.ts` `executeBrowserCapture`.

### When Does It Return `browse_session_open`?

When `tryFirstPassBrowserAction` returns `hit: false` AND the tab is still alive (`firstPassResult.tabId` exists). This happens at:
- **L3050-3095** (fast path)
- **L3349-3404** (post-marketplace fallback)

The handoff sets up:
- Cookie injection from user's browser
- `INTERCEPTOR_SCRIPT` for fetch/XHR capture
- HAR recording
- Session registration via `registerBrowseSession`

### What Triggers `tryFirstPassBrowserAction`?

Called at two points:
1. **L3017** (fast path): Before marketplace, when no local cache
2. **L3309** (fallback): After marketplace fails, before full capture

The function lives in `src/orchestrator/first-pass-action.ts` L125-341:
- Hard 8s deadline (L143-144)
- Opens a fresh Kuri tab
- Navigates to `contextUrl`
- Classifies intent (search/navigate/click/submit/read)
- For `search`: finds search input, types query, submits form
- For `click`: finds button/link, clicks it
- Waits 2s for network to settle
- Collects HAR entries, filters for JSON API responses
- On HIT (JSON found): closes tab, returns `miniSkill`
- On MISS: keeps tab alive (returned as `tabId` for browse session)

---

## 5. Current Timing Analysis

### Best Case: Route Result Cache Hit
- **Path**: Phase 1 only
- **Time**: <1ms (in-memory Map lookup)
- **Source**: `route-cache`

### Good Case: Route Cache with Local Snapshot
- **Path**: Phase 2, local snapshot read
- **Time**: 1-50ms (disk read + ranking)
- **Source**: `marketplace` (labeled, actually from local snapshot)

### Typical Cold Case (with URL): Fast Path
- **Path**: Phase 0 -> 1 (miss) -> 2 (miss) -> 3 (miss) -> 4 (fast path)
- **Time**: 8-12s (first-pass browser + session setup)
- **Source**: `first-pass` or `browse_session_open`
- **What user sees**: Browser opens, first-pass attempts action, either gets JSON or hands off to agent

### Slow Case: Marketplace + Browser Fallback
- **Path**: Phase 0 -> 1 (miss) -> 2 (miss) -> 3 (miss) -> 4 (miss or skipped) -> 5 (marketplace search) -> 6 (browser)
- **Time**: 15-40s
- **Source**: varies

### Worst Case: Full Live Capture
- **Path**: All caches miss, marketplace misses, first-pass misses, live capture
- **Time**: 30-120s (browser launch + page load + capture + extraction + enrichment)
- **Source**: `live-capture`
- **What causes this**: New site never seen before, complex SPA, auth-gated content

### The "Takes Forever" Problem

Multiple cascading serial steps, each with its own timeout:
1. Cache checks are fast but there are **5 sequential cache layers** before any work starts
2. Auto-exec loop tries up to **5 endpoints sequentially** with LLM judge calls (8s each)
3. After auto-exec failure, falls through to live capture (120s timeout)
4. `withDomainCaptureLock` can add unbounded wait time if another capture is in progress

The key bottleneck pattern: **cache miss -> marketplace search (5-30s) -> auto-exec loop (up to 40s) -> live capture (up to 120s)**. Each step must fully complete before the next begins.

---

## 6. The Race Condition Opportunity

### Current Sequential Flow (when URL is available)

```
[Cache checks: ~5ms] -> [First-pass browser: 8s] -> [Marketplace search: 5-30s] -> [Auto-exec: 0-40s] -> [Live capture: 10-120s]
```

### What Could Be Parallelized

**Browser opening is independent of cache/marketplace lookup.** The Kuri browser launch, tab creation, and initial navigation could start immediately while caches and marketplace are checked. If a cache hits, abort the browser. If caches miss, the browser is already loaded.

### Specific Parallelization Opportunities

1. **Kuri start + cache checks in parallel**:
   - `kuri.start()` + `kuri.newTab()` take ~500ms-3s (Kuri cold start)
   - All 5 cache layers take <100ms total
   - Start both simultaneously; if cache hits, close the tab

2. **First-pass browser action + marketplace search in parallel**:
   - Currently the fast path (L2995-3096) already fires marketplace in the background
   - But this only happens when local cache misses. Could start marketplace search at L2775 (before cache checks)
   - The marketplace search result can be checked after first-pass returns

3. **Pre-warm Kuri during cache checks**:
   - At the very start of `resolveAndExecute`, fire `kuri.start()` (idempotent)
   - By the time cache checks fail and first-pass is needed, Kuri is already running

### What Would Need to Change

1. **Extract browser warmup into separate async function**: A `prepareFirstPass(url)` that returns a Promise<{ tabId, kuriReady }> without navigating yet.

2. **Decouple navigation from first-pass**: Currently `tryFirstPassBrowserAction` does tab creation + navigation + action in one function. Split into: tab creation (can start early) and navigation (starts after cache miss confirmed).

3. **Add AbortController to marketplace search**: Already partially done (L3107-3119 uses `Promise.race`), but the abort is not propagated to the underlying fetch.

4. **Restructure `resolveAndExecute` into concurrent phases**:
   ```
   // Start these concurrently:
   const browserReady = warmUpKuri();
   const cacheResult = checkAllCaches();
   const marketplacePromise = searchMarketplace(); // lazy, only resolves if needed

   // First check: did any cache hit?
   const cached = await cacheResult;
   if (cached) { browserReady.abort(); return cached; }

   // No cache: use pre-warmed browser
   const tab = await browserReady;
   const firstPass = await tryFirstPassBrowserAction(tab, ...);

   // While first-pass runs, marketplace may have finished
   const marketplace = await Promise.race([marketplacePromise, timeout(0)]);
   ```

5. **Risk**: Browser side effects (opening visible Chrome window) when HEADLESS=false. Cannot abort a visible browser without user noticing. Mitigation: start Kuri but do not create tab until cache miss confirmed.

### Estimated Impact

| Scenario | Current | With Parallelization |
|----------|---------|---------------------|
| Cache hit + Kuri warm | ~50ms | ~50ms (no change) |
| Cache miss, first-pass hit | 8-12s | 8-12s (Kuri already warm) |
| Cache miss, marketplace hit | 5-35s | 5-10s (marketplace started earlier) |
| Full fallback | 30-120s | 20-100s (Kuri warm + parallel search) |
| Kuri cold start penalty | +3s added to first-pass | 0s (hidden behind cache checks) |

---

## 7. Cache Architecture

### Cache Layers (checked in order)

| Cache | Type | TTL | Key | Location |
|-------|------|-----|-----|----------|
| `routeResultCache` | In-memory Map | 24h | `scope:domain:intent:url` | L214-223 |
| `skillRouteCache` | In-memory Map + disk | 24h | `scope:domain:intent:url` | L129-133, disk: `~/.unbrowse/route-cache.json` |
| `domainSkillCache` | In-memory Map + disk | 7 days | registrable domain | L139-140, disk: `~/.unbrowse/domain-skill-cache.json` |
| Local snapshots | Disk (JSON files) | No expiry | SHA1 of cache key | `~/.unbrowse/skill-snapshots/*.json` |
| `capturedDomainCache` | In-memory Map | 5 min | `scope:domain:intent:url` | L116-119 |

### Cache Promotion

When a resolve succeeds, the result is promoted through multiple cache layers via `promoteLearnedSkill` (L451-479):
1. Writes skill snapshot to disk
2. Stores in `capturedDomainCache` (5min, in-memory)
3. Stores in `skillRouteCache` (24h, persisted)
4. Stores in `domainSkillCache` (7d, persisted)

When auto-exec succeeds, additionally via `promoteResultSnapshot` (L497-511):
5. Stores full result in `routeResultCache` (24h, in-memory)

---

## 8. Auto-Execute Decision Engine

The `tryAutoExecute` function (L2252-2773) is the most complex part of the pipeline. It decides which endpoint to call and whether the result satisfies the intent.

### Ranking Pipeline
1. **BM25 ranking**: `rankEndpoints` scores endpoints by intent match (L2256)
2. **Graph reachability filter**: Remove endpoints that require unavailable bindings (L2287-2294)
3. **Schema tiebreaker**: Boost endpoints whose schema fields match intent tokens (L2308-2340)
4. **Readiness scoring**: Boost for bound params, GET methods, response schemas; penalize missing params, unsafe methods, bundle-inferred endpoints (L2352-2413)
5. **Intent-entity prioritization**: Boost endpoints matching preferred entity types (L2413)
6. **DAG advisory**: Backend graph advisory for cross-session intelligence (L2418-2433)
7. **Auth prerequisite gate**: Resolve auth dependencies before execution (L2436-2454)
8. **LLM endpoint selection**: `agentSelectEndpoint` uses LLM to reorder top candidates (L2469-2471)

### Execution Loop (L2481-2746)
- Tries up to 5 endpoints sequentially
- For each: resolve params (sync defaults + LLM inference) -> `executeSkill` -> local assessment -> LLM judge
- On pass: cache result, record DAG action, prefetch related endpoints
- On fail: continue to next candidate
- All fail: return null (caller falls through to deferral or live capture)

### LLM Calls in Auto-Execute
1. `agentSelectEndpoint` (L2470): Reorder top 5 endpoints. 8s timeout.
2. `inferParamsFromIntent` (L2529-2536): Fill unbound template params. 8s timeout.
3. `agentJudgeExecution` (L2602): Pass/fail the result. 8s timeout.

Each uses `callJsonAgent` (L1450-1490) which tries OpenAI first, then Nebius, with 8s AbortController.

---

## 9. Key File Reference

| File | Role | Key Functions |
|------|------|---------------|
| `src/orchestrator/index.ts` | Main resolve pipeline | `resolveAndExecute` (L1895), `tryAutoExecute` (L2252), `buildDeferral` (L2065), cache management |
| `src/orchestrator/first-pass-action.ts` | 8s lightweight browser attempt | `tryFirstPassBrowserAction` (L125), `classifyIntent` (L26), `synthesizeSkillFromIntercepted` (L75) |
| `src/api/routes.ts` | HTTP API + browse session | `registerRoutes` (L286), browse endpoints (L706-1005), `passiveIndexFromRequests` (L55) |
| `src/cli.ts` | CLI commands | `cmdResolve` (L139), `cmdGo` (L822), `cmdSnap` (L828), `cmdClick` (L838), `cmdFill` (L844), `cmdClose` (L915) |
| `src/browser/index.ts` | Browser API (Page class) | `Page.goto` (L176), `Page.close` (L553), `passiveIndexHar` (L64) |
| `src/execution/index.ts` | Endpoint execution engine | `executeSkill` (L939), `executeBrowserCapture` (L963), `rankEndpoints` (L2535) |
| `src/orchestrator/dag-advisor.ts` | DAG advisory boosts | `fetchDagAdvisoryPlan`, `applyDagAdvisoryBoosts` |
| `src/orchestrator/passive-publish.ts` | Background marketplace publish | `queuePassiveSkillPublish` |
| `src/graph/index.ts` | Operation graph + reachability | `getSkillChunk`, `computeReachableEndpoints`, `ensureSkillOperationGraph` |
| `src/capture/prefetch.ts` | Prefetch related endpoints | `getPrefetchTargets`, `executePrefetch` |

---

## 10. Passive Indexing Pipeline

Three locations trigger the same enrichment pipeline:

### 1. Browse session close (`src/api/routes.ts` L894-1005)
- Merges intercepted + HAR requests
- Synchronous quick-cache (endpoints extracted + snapshot written immediately)
- Async full pipeline via `passiveIndexFromRequests`

### 2. Page navigation flush (`src/api/routes.ts` L738-743, `src/browser/index.ts` L218-224)
- On `go`/`goto` to new URL, flush HAR for old page
- Calls `passiveIndexHar`

### 3. Page close (`src/browser/index.ts` L553-574)
- Same as browse session close but via the Browser API

### Full Enrichment Pipeline (`passiveIndexFromRequests`, `src/api/routes.ts` L55-153)
1. `extractEndpoints(requests)` -- reverse-engineer API endpoints from raw HTTP
2. `extractAuthHeaders(requests)` -- find auth tokens/cookies
3. `storeCredential(domain-session, ...)` -- persist auth to vault
4. `mergeEndpoints(existing, new)` -- never reduce endpoint count
5. `generateLocalDescription(ep)` -- heuristic BM25-friendly descriptions
6. `buildSkillOperationGraph(endpoints)` -- dependency graph
7. `cachePublishedSkill(skill)` -- local cache for immediate reuse
8. `writeSkillSnapshot(key, skill)` -- disk persistence
9. `domainSkillCache.set(...)` -- domain-level cache
10. `queueBackgroundIndex(...)` -- marketplace publish (async)

---

*Resolve pipeline analysis: 2026-04-02*
