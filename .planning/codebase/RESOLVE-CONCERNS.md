# Resolve Pipeline: Blocking and Timeout Concerns

**Analysis Date:** 2026-04-02

## 1. Every Await in the Resolve Path

The `resolveAndExecute` function in `src/orchestrator/index.ts` (L1895-3809) is the main entry point. Below is every significant await on the critical path, in execution order, with timeout status.

### Phase 1: Cache Lookups (L2780-2993)

| Await | Location | Timeout | Value | On Timeout |
|-------|----------|---------|-------|------------|
| `readSkillSnapshot()` | L2821 | None (sync fs read) | N/A | N/A |
| `getSkillWithTimeout()` | L2822 | Yes | `MARKETPLACE_GET_SKILL_TIMEOUT_MS` = 2500ms (default, env override) | Returns `null`, falls through |
| `buildDeferralWithAutoExec()` | L2846 | **NO** | Unbounded | **Blocks indefinitely** (calls `tryAutoExecute` which loops) |
| `getSkill()` (domain cache) | L2866 | **NO** | Uses `api()` with 8s `API_TIMEOUT_MS` | Throws, caught |
| `buildDeferralWithAutoExec()` | L2869 | **NO** | Unbounded | **Blocks indefinitely** |
| `findBestLocalDomainSnapshot()` | L2888 | None (sync fs) | N/A | N/A |

### Phase 2: Fast-Path Browser (L2999-3096) -- when URL available, no local cache

| Await | Location | Timeout | Value | On Timeout |
|-------|----------|---------|-------|------------|
| `searchIntentResolve()` (fire-and-forget) | L3005 | **NO** | `api()` has 8s, but this is void | Never blocks caller |
| `tryFirstPassBrowserAction()` | L3017 | Yes | Hard 8s deadline (L143-144 in `first-pass-action.ts`) | Returns `miss` |
| `kuri.start()` | L177 (first-pass) | Yes | `KURI_STARTUP_TIMEOUT_MS` = 10s + 3 retries x 1s delay = **worst case 43s** | Throws, caught |
| `kuri.navigate()` | L206 (first-pass) | Bounded by 8s deadline | ~1.5s wait after | Returns miss |
| `kuri.evaluate()` (search action) | L225-241 | Bounded by 8s deadline | | Returns miss |
| `sleep(2000)` | L267 | Bounded by deadline | Up to 2s | Returns miss |
| `kuri.harStop()` | L278 | **NO** (within 8s deadline) | | Best-effort |
| Cookie injection loop | L3057 | **NO** | Per-cookie `setCookie` has no timeout | Could block if many cookies |
| `kuri.evaluate(INTERCEPTOR_SCRIPT)` | L3059 | **NO** | `KURI_REQUEST_TIMEOUT_MS` = 30s | Blocks up to 30s |
| `kuri.harStart()` | L3060 | **NO** | 30s | Blocks up to 30s |
| `registerBrowseSession()` | L3063-3066 | None (sync) | N/A | N/A |

### Phase 3: Marketplace Search (L3099-3268) -- fallback when fast-path unavailable

| Await | Location | Timeout | Value | On Timeout |
|-------|----------|---------|-------|------------|
| `searchIntentResolve()` | L3107-3124 | Yes | `Promise.race` with 5s (URL) or 30s (no URL) | Returns empty results |
| `getSkillWithTimeout()` (parallel, up to 4) | L3153-3154 | Yes | 2500ms per skill | Returns `null` |
| `executeSkill()` (agent-chose, `Promise.any` race) | L3192-3220 | Yes | 30s per candidate | Rejects on timeout |
| `buildDeferralWithAutoExec()` (best marketplace) | L3262 | **NO** | Unbounded | **Blocks indefinitely** |

### Phase 4: Live Capture (L3406-3571)

| Await | Location | Timeout | Value | On Timeout |
|-------|----------|---------|-------|------------|
| `withOpTimeout("live_capture_wait")` | L3473-3476 | Yes | `LIVE_CAPTURE_TIMEOUT_MS` = 120s (env override) | Rejects with timeout error |
| `withAbortableOpTimeout("live_capture_execute")` | L3524-3534 | Yes | `LIVE_CAPTURE_TIMEOUT_MS` = 120s | Aborts signal, rejects |
| `withDomainCaptureLock()` | L3540 | **NO** | Waits for prior capture to complete | **Blocks indefinitely** if prior capture hangs |
| `getOrCreateBrowserCaptureSkill()` | L3523, 3562 | **NO** | Calls `getSkill()` then `publishSkill()` -- both use `api()` 8s | Could block 16s (get+publish) |

### Phase 5: Auto-Execute Loop -- `tryAutoExecute()` (L2252-2773)

| Await | Location | Timeout | Value | On Timeout |
|-------|----------|---------|-------|------------|
| `fetchDagAdvisoryPlan()` | L2420-2421 | Yes (graph client) | `GRAPH_TIMEOUT_MS` = 4s (env override) | Falls through to local planner |
| `resolveAuthPrerequisites()` | L2443 | **NO** | `LocalAuthRuntime.resolveAuth` is sync in-memory check | Fast, but no timeout guard |
| `agentSelectEndpoint()` (LLM call) | L2470 | **NO** | Calls `callJsonAgent` with 8s timeout (L1457) | Returns fallback order |
| `inferParamsFromIntent()` (LLM call) | L2530-2535 | **NO** | Calls `callJsonAgent` with 8s timeout (L1457) | Returns empty |
| `executeSkill()` per candidate | L2537-2551 | **NO** | No per-candidate timeout | **Blocks indefinitely** per execution |
| `assessLocalExecutionResult()` | L2554 | None (sync) | N/A | N/A |
| `agentJudgeExecution()` (LLM call) | L2602 | **NO** | Calls `callJsonAgent` with 8s timeout (L1457) | Returns "skip" |
| `executePrefetch()` | L2662 | **NO** | Fires prefetch with no timeout | Could block |
| `checkPaymentRequirement()` | L2673 | **NO** | Uses `api()` 8s | Could block 8s |

**Worst case auto-execute loop:** 5 candidates x (8s LLM param inference + unbounded executeSkill + 8s LLM judge) = **5 x (8 + ? + 8)** = at least 80s + execution time per candidate.

---

## 2. Marketplace Calls Without Timeouts

### `searchIntentResolve()` -- `src/client/index.ts` L637-668

The function itself has **no timeout**. It calls `api()` (L193-245) which uses a global `API_TIMEOUT_MS` of **8s** (L130). The orchestrator wraps it in `Promise.race` with a 5s/30s timeout (L3107-3119), but there are code paths where it is called without the race wrapper:

- **Fire-and-forget in fast-path** (L3003-3014): No timeout needed (void), but also no error surfacing.
- **Background marketplace search in evaluate harness**: May hang for 8s silently.

### Skill Hydration -- `getSkillWithTimeout()` vs `getSkill()`

`getSkillWithTimeout()` (L555-564) wraps `getSkill()` in a `Promise.race` with configurable timeout (default 2500ms). **BUT** several code paths call `getSkill()` directly without the timeout wrapper:

- `src/orchestrator/index.ts` L2866: `getSkill(domainCached.skillId, clientScope)` -- **NO timeout wrapper**
- `src/orchestrator/index.ts` L3812: `getSkill(BROWSER_CAPTURE_SKILL_ID)` -- **NO timeout wrapper**
- `src/api/routes.ts` L462: `getSkill(skill_id, clientScope)` -- **NO timeout wrapper**

Each of these inherits only the `api()` 8s timeout. If the backend is slow but responsive, they block for 8s.

### `executeSkill()` Within Auto-Execute

`executeSkill()` at L2537 has **no timeout at all**. The function delegates to `executeEndpoint()` (L1577) which:
- For DOM extraction: calls `tryHttpFetch()` with a **10s timeout** (L1476), then potentially launches a browser with **no timeout** on the kuri navigate/evaluate chain.
- For HTTP API calls: uses `withRetry()` which has **no per-attempt or aggregate timeout**. The underlying `fetch()` uses `AbortSignal.timeout()` but the value depends on the code path.

---

## 3. The Auto-Execute Retry Loop

**Location:** `src/orchestrator/index.ts` L2252-2773, function `tryAutoExecute()`

### Candidate count
- `MAX_TRIES = Math.min(tryList.length, 5)` (L2462)
- `tryList` is built from ranked endpoints, filtered by `canAutoExecuteEndpoint()` safety check
- Deduplication via `dedupeObservedOverBundle()` reduces candidates

### Per-candidate work
Each iteration (L2481-2745) does:
1. **Sync param resolution** -- fast, no await
2. **LLM param inference** (`inferParamsFromIntent`) -- up to **8s** (callJsonAgent timeout at L1457)
3. **`executeSkill()`** -- **UNBOUNDED**. For HTTP endpoints: 1 fetch + up to 3 retries. For browser capture: could launch kuri + navigate + extract = 30s+. For DOM extraction: 10s HTTP + potential browser fallback.
4. **Local assessment** (`assessLocalExecutionResult`) -- sync, fast
5. **LLM judge** (`agentJudgeExecution`) -- up to **8s** (callJsonAgent timeout)

### Aggregate worst case
- 5 candidates x (8s LLM params + 30s execute + 8s LLM judge) = **230 seconds**
- With all HTTP endpoints (faster execute): 5 x (8 + 8 + 8) = **120 seconds**
- With fast sync param resolution + HTTP: 5 x (0 + 8 + 8) = **80 seconds**

### No aggregate timeout
There is **no aggregate deadline** on the auto-execute loop. A single slow candidate cannot be interrupted, and the loop does not check elapsed time.

### LLM call sharing
`callJsonAgent()` (L1450-1490) is called for:
- `agentSelectEndpoint()` -- 1 call before the loop
- `inferParamsFromIntent()` -- 1 call per candidate with unresolved params
- `agentJudgeExecution()` -- 1 call per candidate that succeeds

With 5 candidates, this is up to **11 LLM calls x 8s = 88s** of LLM time alone.

---

## 4. Browser Startup Time

**Kuri process startup** (`src/kuri/client.ts` L281-391):
- Health check poll: every 200ms until `KURI_STARTUP_TIMEOUT_MS` = **10s**
- If already running: ~1s (health check + tab discovery)
- Cold start with existing Chrome: **3-5s** typical
- Cold start launching Chrome: **5-10s** typical
- Retry on failure: `KURI_SPAWN_RETRIES` = 3, with `KURI_SPAWN_RETRY_DELAY_MS` = 1s between
- **Worst case: 4 attempts x (10s timeout + 1s delay + 1s kill) = 48s**

**Navigation** (`kuri.navigate()`):
- Uses `kuriPost()` with `KURI_REQUEST_TIMEOUT_MS` = **30s**
- No separate page-load timeout at the kuri client level

**First-pass browser action** (`src/orchestrator/first-pass-action.ts`):
- Hard deadline: **8s** from start (L143-144)
- But `kuri.start()` at L177 is **outside the deadline check** -- if kuri takes 10s to start, the deadline is already blown when navigation begins
- Actual abort happens via `isAborted()` check, not via AbortSignal on kuri calls

**Interceptor injection**:
- `kuri.evaluate(tabId, INTERCEPTOR_SCRIPT)` -- 30s timeout (kuri request timeout)
- Called at browse session handoff (L3059, L3359) -- **not bounded by any deadline**

---

## 5. Passive Indexing Timing

### On `close` (`src/api/routes.ts` L895-1005)

The close handler does **both synchronous and asynchronous work**:

**Synchronous (blocking the response):**
1. `kuri.authProfileSave()` -- awaited, no timeout (30s kuri default)
2. `collectInterceptedRequests()` -- awaited, no timeout
3. `kuri.harStop()` -- awaited, no timeout
4. `extractEndpoints()` -- synchronous CPU work
5. `mergeEndpoints()` -- synchronous
6. `writeSkillSnapshot()` -- synchronous fs write
7. `cachePublishedSkill()` -- synchronous
8. `invalidateRouteCacheForDomain()` -- synchronous
9. `kuri.closeTab()` -- awaited, no timeout

**Asynchronous (fire-and-forget, does NOT block response):**
10. `passiveIndexFromRequests()` (L1001) -- void async IIFE

The `reply.send()` at L1004 fires **after** steps 1-9 complete. This means the close response is blocked by:
- `kuri.authProfileSave()` -- could take seconds if writing auth state
- `collectInterceptedRequests()` -- evaluates JS in the browser tab, could be slow
- `kuri.harStop()` -- collects all buffered HAR entries
- `kuri.closeTab()` -- closes the tab

**Worst case close time: 30s (authProfileSave) + 30s (collectIntercepted) + 30s (harStop) + 30s (closeTab) = 120s**

### `passiveIndexFromRequests()` background pipeline (`src/api/routes.ts` L55-152)

This is fire-and-forget (void async IIFE). It runs:
1. `extractEndpoints()` -- CPU-bound
2. `storeCredential()` -- vault write
3. `findExistingSkillForDomain()` -- local cache lookup
4. `mergeEndpoints()` -- CPU-bound
5. `generateLocalDescription()` per endpoint -- CPU-bound
6. `buildSkillOperationGraph()` -- CPU-bound
7. `cachePublishedSkill()` -- local cache write
8. `writeSkillSnapshot()` -- fs write
9. `queueBackgroundIndex()` -- queues for marketplace publish

None of this blocks the close response, but it competes for CPU and memory with concurrent requests.

---

## 6. Race Conditions

### Snap during resolve

`browseSessions` is a module-level `Map<string, ...>` in `src/api/routes.ts` L160. The key is always `"default"` (L164). Both `resolveAndExecute` (via `registerBrowseSession`) and browse commands (`/v1/browse/snap`, `/v1/browse/click`, etc.) access this shared state.

**Race scenario:**
1. Agent calls `resolve` -- orchestrator opens a first-pass tab, gets a miss, calls `registerBrowseSession("default", tabId, ...)` at L3063
2. Agent immediately calls `snap` -- `getOrCreateBrowseSession()` returns the session registered in step 1
3. Meanwhile, `resolveAndExecute` is still setting up the browse session (injecting cookies, starting HAR) at L3057-3060
4. The `snap` call operates on a tab that has not finished setup -- HAR may not be recording, interceptor may not be injected

**Impact:** Snap returns stale/incomplete data. No locking mechanism exists.

### Two concurrent resolves on the same domain

**Serialization via `withDomainCaptureLock()`** (L896-916): The `captureDomainLocks` map ensures only one live capture runs per domain at a time. Subsequent callers wait for the first to complete.

**BUT:** The lock only covers the live capture phase (L3540). Everything before that -- cache lookups, marketplace search, first-pass browser action, auto-execute loop -- runs **without any lock**. Two concurrent resolves for the same domain can both:
1. Run marketplace searches simultaneously (wasted compute)
2. Both enter the first-pass browser action, opening two tabs for the same domain
3. Both try to register browse sessions under key `"default"`, overwriting each other

**Capture in-flight queue** (`captureInFlight` at L122-125): Prevents duplicate live captures. The second caller waits for the first promise. But this only works within the same Node.js process -- packaged CLI spawns separate server processes.

### Route cache write races

`skillRouteCache` and `domainSkillCache` are in-memory Maps with periodic disk persistence. No mutex or atomic write -- two concurrent resolves can:
1. Both write to the same cache key
2. The flush timer (L168-177, 5s interval) may write stale data
3. `persistRouteCache()` just sets a dirty flag -- actual write is batched

**Impact:** Last-write-wins, potential stale cache entries. Not catastrophic but can cause unnecessary re-captures.

### Browse session singleton

`browseSessions.set("default", ...)` at L164 means **only one browse session can exist at a time**. If an agent opens two tabs (via two resolve calls), the second overwrites the first. The first tab becomes orphaned -- HAR data is never collected, tab is never closed.

---

## 7. Summary of Critical Blocking Issues

### P0: Auto-execute loop has no aggregate timeout
- **Files:** `src/orchestrator/index.ts` L2252-2773
- **Impact:** 5 candidates x (8s + unbounded execute + 8s) = can block for minutes
- **Fix:** Add aggregate deadline (e.g., 30s) to the tryAutoExecute loop. Abort remaining candidates when deadline reached.

### P0: `executeSkill()` has no timeout in auto-execute path
- **Files:** `src/orchestrator/index.ts` L2537
- **Impact:** A single slow endpoint blocks the entire resolve pipeline
- **Fix:** Wrap `executeSkill()` calls in auto-execute with `withOpTimeout("autoexec_candidate", 15_000, ...)`.

### P1: `kuri.start()` can block up to 48s before first-pass deadline starts
- **Files:** `src/orchestrator/first-pass-action.ts` L177, `src/kuri/client.ts` L281-391
- **Impact:** 8s first-pass deadline is meaningless if kuri takes 10-48s to start
- **Fix:** Start the 8s deadline BEFORE `kuri.start()`, or limit kuri startup to 5s with 1 retry.

### P1: Browse session handoff has no timeout on cookie/interceptor setup
- **Files:** `src/orchestrator/index.ts` L3055-3066, L3353-3369
- **Impact:** Cookie injection loop + evaluate(INTERCEPTOR_SCRIPT) can block 30s+ each
- **Fix:** Wrap handoff setup in a 5s aggregate timeout. Proceed without cookies/interceptor on timeout.

### P1: Close handler blocks response while awaiting kuri operations
- **Files:** `src/api/routes.ts` L895-1005
- **Impact:** Close response delayed by authProfileSave + collectIntercepted + harStop + closeTab = up to 120s
- **Fix:** Move kuri operations to fire-and-forget. Send response immediately after synchronous cache write. Run kuri cleanup async.

### P2: `getSkill()` called without timeout wrapper in domain cache path
- **Files:** `src/orchestrator/index.ts` L2866
- **Impact:** Blocks 8s if backend is slow
- **Fix:** Use `getSkillWithTimeout()` consistently.

### P2: `withDomainCaptureLock()` has no timeout
- **Files:** `src/orchestrator/index.ts` L896-916
- **Impact:** If a live capture hangs (despite the 120s timeout on the capture itself), subsequent callers wait forever
- **Fix:** Add a timeout on the lock acquisition (e.g., `Promise.race` with 130s).

### P2: Race on browse session singleton
- **Files:** `src/api/routes.ts` L160, L164
- **Impact:** Concurrent resolves overwrite each other browse session. Orphaned tabs leak.
- **Fix:** Use tab-id-keyed sessions instead of `"default"` singleton.

---

## 8. Timeout Configuration Reference

| Constant | Location | Default | Env Override |
|----------|----------|---------|-------------|
| `LIVE_CAPTURE_TIMEOUT_MS` | `src/orchestrator/index.ts` L42 | 120,000ms (2min) | `UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS` |
| `MARKETPLACE_GET_SKILL_TIMEOUT_MS` | `src/orchestrator/index.ts` L226 | 2,500ms | `UNBROWSE_MARKETPLACE_GET_SKILL_TIMEOUT_MS` |
| `MARKETPLACE_TIMEOUT_MS` | `src/orchestrator/index.ts` L3101 | 5,000ms (with URL) / 30,000ms (without) | None |
| `API_TIMEOUT_MS` | `src/client/index.ts` L130 | 8,000ms | `UNBROWSE_API_TIMEOUT` |
| `GRAPH_TIMEOUT_MS` | `src/client/graph-client.ts` L4 | 4,000ms | `UNBROWSE_GRAPH_TIMEOUT_MS` |
| `KURI_STARTUP_TIMEOUT_MS` | `src/kuri/client.ts` L18 | 10,000ms | None |
| `KURI_REQUEST_TIMEOUT_MS` | `src/kuri/client.ts` L19 | 30,000ms | None |
| `KURI_SPAWN_RETRIES` | `src/kuri/client.ts` L20 | 3 | None |
| `KURI_SPAWN_RETRY_DELAY_MS` | `src/kuri/client.ts` L21 | 1,000ms | None |
| `callJsonAgent` timeout | `src/orchestrator/index.ts` L1457 | 8,000ms | None |
| First-pass deadline | `src/orchestrator/first-pass-action.ts` L143 | 8,000ms | None |
| WebSocket endpoint | `src/execution/index.ts` L1594 | 7,000ms | None |
| `tryHttpFetch` timeout | `src/execution/index.ts` L1476 | 10,000ms | None |
| Direct JSON fetch | `src/orchestrator/index.ts` L3282 | 5,000ms | None |

---

*Resolve pipeline timeout audit: 2026-04-02*