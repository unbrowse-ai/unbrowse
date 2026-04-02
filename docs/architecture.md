# Unbrowse Architecture

Unbrowse is an API-native agent browser. It discovers internal APIs (shadow APIs) from real browsing traffic and progressively replaces browser interactions with cached API routes. This document describes how the system works end-to-end.

## Three-Path Execution Model

Every intent resolution follows three paths in priority order:

```
Intent ("get top stories from HN")
  │
  ├─ Path 1: Local Cache ──────── cached skill + endpoint → execute → result (< 100ms)
  │
  ├─ Path 2: Shared Route Graph ─ marketplace search → skill fetch → execute → result (~1s)
  │
  └─ Path 3: Browser Fallback ── Kuri browser → capture traffic → learn skill → result (8-30s)
```

**Path 1** is a local lookup — zero network calls, sub-100ms. The route cache stores skill+endpoint pairs from prior successful executions.

**Path 2** queries the shared marketplace — a collectively maintained index of discovered routes across all Unbrowse users. Skills are fetched, ranked by composite score, and the best endpoint is executed.

**Path 3** launches a Kuri browser session, navigates to the target URL, captures all network traffic, reverse-engineers the site's internal APIs, builds a skill manifest, and executes the best endpoint. The learned skill is cached locally and published to the marketplace for future users.

Each path falls through to the next only when the previous path fails or returns no result.

## Resolve Decision Tree

The orchestrator (`src/orchestrator/index.ts`) implements a 10-step decision cascade:

### 1. Route Result Cache
Check `routeResultCache` for an exact intent+domain+URL match from a prior execution. If the cached result is fresh and the intent is coherent, return it immediately. This is the fastest path — no endpoint execution needed.

### 2. Route Cache (Skill + Endpoint Pair)
Query `skillRouteCache` for a previously resolved skill+endpoint combination. If found, attempt auto-execution. If the endpoint is stale (returns error), invalidate the cache and fall through.

### 3. Domain-Level Reuse
Check `domainSkillCache` and local disk snapshots for the same domain with a different intent. A skill discovered for "get feed posts" on linkedin.com can serve "get notifications" if it has a matching endpoint. TTL: 7 days.

### 4. Marketplace Search
Single remote vector search via `searchIntentResolve()`. Returns domain-matched and global candidates. For each candidate:
- Fetch the skill manifest in parallel
- Compute composite score (see Scoring below)
- Filter by lifecycle (active only), endpoint usability, and intent relevance
- If a clear winner exists (20%+ score gap over #2), auto-execute it
- Otherwise, return a deferral with ranked endpoints for the agent to choose

### 5. Direct JSON Fetch
If the URL pattern suggests a raw API endpoint (`.json`, `/api/`, `format=json`), attempt a direct HTTP GET with a 5-second timeout. Return the JSON if valid.

### 6. First-Pass Browser Action
Launch a lightweight 8-second Kuri session: navigate to the URL, perform a single action (search or click based on intent), intercept API calls via HAR + fetch/XHR monkeypatch. If APIs are captured, synthesize a mini-skill and return the result.

### 7. Browse Session Handoff
If first-pass captured a page but no APIs, keep the tab alive and return `browse_session_open` to the calling agent. The agent drives the browser via `snap`, `click`, `fill`, `close` commands. All traffic is passively indexed.

### 8. Recently-Captured Domain Cache
Check `capturedDomainCache` for domains captured in the current session but not yet indexed to the marketplace. Validate and reuse if still relevant.

### 9. In-Flight Capture Queue
If another request for the same domain is already running a live capture, wait for it to complete and reuse the learned skill. Prevents duplicate browser sessions.

### 10. Live Browser Capture
Full agentic browse session: navigate, interact with the page, wait for API calls, extract endpoints, build operation graph, execute the best endpoint. Cache locally and queue background publish to the marketplace.

## Composite Endpoint Scoring

When multiple endpoints match an intent, the orchestrator ranks them:

| Signal | Weight | Description |
|--------|--------|-------------|
| Semantic similarity | 40% | BM25 + embedding match between intent and endpoint description |
| Reliability | 30% | Historical success rate, verification status |
| Freshness | 15% | Inverse decay: `1/(1+d/30)` where d = days since last verified |
| Verification | 15% | Whether the endpoint has been automatically verified in the last 6 hours |

Additional bonuses/penalties during auto-execution:
- Template params fully bound: **+40**
- Safe method (GET): **+15**
- Has response schema: **+10**
- Real API endpoint (not DOM extraction): **+20**
- Missing template params: **-25 per param**
- Suspicious patterns (recaptcha, csrf, tracking): **-20**
- Bundle-inferred endpoint (never observed live): **-20 to -80**

## Capture & Enrichment Pipeline

When Path 3 (browser fallback) triggers, captured traffic goes through a six-stage enrichment pipeline before becoming a usable skill:

### Stage 1: Traffic Capture
**Source:** `src/capture/index.ts`

Three mechanisms capture network traffic simultaneously:
- **INTERCEPTOR_SCRIPT**: Monkeypatches `window.fetch()` and `XMLHttpRequest` to capture request/response bodies. Stores up to 500 entries in `window.__unbrowse_intercepted`. Body size limit: 512KB (JS: 2MB).
- **HAR logging**: Kuri extension records traffic via Chrome DevTools Protocol.
- **Extension observer**: Falls back to `chrome.webRequest` API.

On session close, `mergePassiveCaptureData()` deduplicates across all three sources (JS interceptor takes priority over HAR over extension), producing unified `RawRequest[]`.

### Stage 2: DOM & SPA Extraction
**Source:** `src/extraction/index.ts`

Multi-strategy extraction from the page HTML:
1. Extract SPA-embedded JSON from script tags and JSON-LD
2. Run domain-specific extractors (GitHub, LinkedIn, Twitter, etc.)
3. Parse structured DOM: tables, definition lists, repeating patterns
4. Score each structure by intent relevance, semantic fit, field richness
5. Pick the best extraction or return multiple candidates for ranking

Produces `ExtractionResult` with data, extraction method, confidence score, and CSS selector.

### Stage 3: Endpoint Reverse-Engineering
**Source:** `src/reverse-engineer/index.ts`

Transforms raw traffic into structured API endpoint descriptors:
1. **Filter**: `isApiLike()` checks content-type (JSON, HTML, protobuf), URL patterns, affinity domain
2. **Schema inference**: Parse response JSON, call `inferSchema()` to build response_schema
3. **Templatization**: Replace query params with `{param}` placeholders, detect entity IDs in paths, templatize body fields
4. **CSRF detection**: `inferCsrfPlan()` for POST forms
5. **Semantic enrichment**: `inferEndpointSemantic()` assigns action_kind, resource_kind, requires/provides bindings
6. **Deduplication**: `collapseEndpoints()` merges sibling endpoints (e.g., `/ticker/AAPL` + `/ticker/TSLA` → `/ticker/{ticker}`)

Produces `EndpointDescriptor[]` with url_template, method, response_schema, semantic metadata.

### Stage 4: Operation Graph Building
**Source:** `src/graph/index.ts`

Constructs a dependency DAG over endpoints:
1. Create `SkillOperationNode` per endpoint with requires/provides bindings
2. Infer edges by matching requirements against provides (exact key match, semantic match, pagination self-match)
3. Classify edges by dependency type (data flow, trigger, hint)
4. Identify entry points: root operations with no unmet dependencies

Produces `SkillOperationGraph` with operations, edges, and entry_operation_ids.

### Stage 5: LLM Augmentation
**Source:** `src/graph/agent-augment.ts`

Refines semantic metadata via LLM (8-second timeout with fallback to unaugmented):
1. Select endpoints by priority: those with response schemas and DOM extraction rank highest
2. Compact endpoint data to fit within 24KB payload limit
3. Call LLM with system prompt enforcing grounded semantic types
4. Merge updates: action_kind, resource_kind, description_out, requires/provides bindings

### Stage 6: Background Indexing & Publishing
**Source:** `src/indexer/index.ts`

Finalizes the skill for reuse:
1. Merge with existing domain snapshot (accumulate endpoints across captures)
2. Regenerate operation graph with merged endpoints
3. Sanitize for publish: redact secrets (JWTs, API keys), synthesize placeholder examples
4. Validate manifest structure
5. Publish to marketplace (~1.5s)
6. Update local domain cache for cross-intent reuse

## Execution

Once the orchestrator selects an endpoint, execution is handled by `src/execution/index.ts`:

### HTTP Endpoints
1. Resolve auth: load cookies from vault, extract from browser if needed
2. Interpolate URL template with bound parameters
3. Build request headers (including CSRF if detected)
4. Send HTTP request with timeout
5. Parse response, validate against expected schema
6. Detect drift if response shape changed from recorded schema

### DOM Extraction Endpoints
For endpoints that extract data from rendered HTML rather than API calls:
1. **SSR fast-path**: Attempt plain HTTP fetch first (no browser needed)
2. Run `extractFromDOMWithHint()` with the stored CSS selector
3. Validate extraction quality and semantic relevance
4. **Browser fallback**: If SSR extraction fails, launch Kuri to render the page
5. Deduplicate: if multiple candidate extractions returned, pick the highest-scored one

### Mutation Safety
Non-GET endpoints marked as `unsafe` require explicit `confirm_unsafe: true`. Without it, execution returns a `confirmation_required` error with a preview of what would be sent.

## Skill Lifecycle

Skills progress through lifecycle states:

| State | Meaning |
|-------|---------|
| `active` | Verified within the last 6 hours, available for execution |
| `deprecated` | Verification failures detected, still usable but ranked lower |
| `disabled` | Consecutive failures exceeded threshold, excluded from results |

Verification runs on a 6-hour loop. Freshness decays as `1/(1+d/30)` where d is days since last verification. Skills with `consecutive_failures > 3` are automatically disabled.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/orchestrator/index.ts` | Intent resolution, 10-step decision cascade, endpoint ranking |
| `src/orchestrator/first-pass-action.ts` | Lightweight 8s browser probe |
| `src/orchestrator/browser-agent.ts` | Agentic browse fallback with step-by-step DOM planning |
| `src/execution/index.ts` | HTTP and DOM endpoint execution, auth injection, drift detection |
| `src/capture/index.ts` | HAR + fetch/XHR interceptor, session recording |
| `src/extraction/index.ts` | Multi-strategy DOM/SPA data extraction |
| `src/reverse-engineer/index.ts` | Traffic → endpoint descriptor inference |
| `src/graph/index.ts` | Operation graph (DAG) construction |
| `src/graph/agent-augment.ts` | LLM semantic enrichment |
| `src/graph/planner.ts` | Execution plan builder, topological sort |
| `src/indexer/index.ts` | Background skill publishing to marketplace |
| `src/api/routes.ts` | REST API handlers |
| `src/auth/index.ts` | Cookie extraction, vault, browser login |
| `src/kuri/client.ts` | Kuri browser CDP client |
