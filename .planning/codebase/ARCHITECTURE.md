# Architecture

**Analysis Date:** 2026-04-01

## Pattern Overview

**Overall:** Local server + CLI thin client, with a cloud marketplace backend for skill sharing.

**Key Characteristics:**
- CLI sends HTTP to a local Fastify server (default port 6969); the server is auto-started detached if not running
- Orchestrator is the central routing brain: cache then marketplace then live browser capture
- Kuri (Zig-native binary, 464 KB) is the sole browser engine; it replaces Playwright, communicates over HTTP/CDP
- Skills (site-specific API manifests) are learned once, published to a cloud marketplace, and replayed on demand
- Graph layer models endpoints as operation nodes with typed bindings (DAG advisory planning)

---

## Layers

**CLI (`src/cli.ts`):**
- Purpose: Shell-safe wrapper for the local API. Parses args, calls `http://localhost:6969/v1/*`, formats output
- Location: `src/cli.ts`
- Depends on: `src/runtime/local-server.ts` (auto-start), `src/client/index.ts` (registration), `src/cli/shortcuts.ts`
- Entry: Users run `unbrowse <command>`. Single-binary mode delegates via `src/single-binary.ts`

**Local Server (`src/server.ts`, `src/index.ts`):**
- Purpose: Fastify HTTP API, binds on `HOST:PORT` (default `127.0.0.1:6969`)
- Location: `src/server.ts` (factory), `src/index.ts` (entrypoint)
- Startup sequence: pre-start Kuri then `ensureRegistered()` then register CORS + rate limiter + routes then start listening then schedule periodic verification
- Writes a JSON PID file (`~/.unbrowse/run/server-<host>-<port>.json`) with `{ pid, base_url, started_at }`
- Shutdown: `shutdownAllBrowsers()` (closes Kuri tabs), then Fastify close, then clears PID file
- Key files: `src/server.ts`, `src/index.ts`, `src/runtime/local-server.ts`

**API Routes (`src/api/routes.ts`):**
- Purpose: Registers all HTTP endpoints on Fastify instance
- Key routes:
  - `POST /v1/intent/resolve` → `resolveAndExecute()` (orchestrator)
  - `GET  /v1/skills/:skill_id` → `getSkill()`
  - `POST /v1/skills/:skill_id/chunk` → `getSkillChunk()`
  - `POST /v1/skills/:skill_id/execute` → `executeSkill()`
  - `POST /v1/skills/:skill_id/auth` → `interactiveLogin()`
  - `POST /v1/auth/login` → `interactiveLogin()`
  - `POST /v1/auth/steal` → `extractBrowserAuth()`
  - `POST /v1/skills/:skill_id/verify` → skill verification
  - `POST /v1/feedback` → `recordFeedback()`
  - `GET  /v1/stats` → npm/GitHub stats (5-minute cache)
  - `GET  /health` → `{ status, trace_version, code_hash, git_sha }`
  - `GET  /v1/sessions/:domain` → session log list
- Location: `src/api/routes.ts`

**Orchestrator (`src/orchestrator/index.ts`):**
- Purpose: Central routing logic for `resolveAndExecute()`. The 3,634-line core of the system.
- Primary function: `resolveAndExecute(intent, params, context, projection, options) → OrchestratorResult`
- Decision priority (in order):
  1. Agent explicitly passed `endpoint_id` → direct execute via `promoteExplicitExecution()`
  2. `force_capture` flag → clear all caches, go straight to live capture
  3. Route result cache hit (in-memory `routeResultCache`) → return cached result immediately
  4. Route cache hit (`skillRouteCache`) → fetch skill + auto-exec
  5. Domain cache (`domainSkillCache`) → reuse known best skill for this domain
  6. Local skill snapshot on disk → try execution before remote search
  7. Marketplace semantic search (`searchIntentResolve`) → hydrate top-K candidates
  8. Live browser capture → `captureSession()` + `extractEndpoints()` + publish skill
- Caches (all keyed by `clientScope:domain:intent`):
  - `capturedDomainCache` — in-memory, 60s TTL, post-capture
  - `captureInFlight` — deduplicates concurrent captures for same domain
  - `captureDomainLocks` — serializes browser launches per domain
  - `skillRouteCache` — in-memory + disk (`~/.unbrowse/route-cache.json`), 24h TTL
  - `domainSkillCache` — in-memory + disk (`~/.unbrowse/domain-skill-cache.json`), 7-day TTL
  - `routeResultCache` — in-memory result cache
- Result types: either an immediate data result or a deferral (skill + ranked endpoint list for agent to choose)
- Sub-modules: `src/orchestrator/dag-advisor.ts` (DAG planning), `src/orchestrator/dag-feedback.ts` (score feedback), `src/orchestrator/first-pass-action.ts` (browser fallback), `src/orchestrator/passive-publish.ts` (background publish)

**Capture (`src/capture/index.ts`):**
- Purpose: Launch a Kuri-managed Chrome tab, navigate to the target URL, harvest HAR network traffic, cookies, HTML, and JS bundles
- Key functions:
  - `captureSession(url, options)` — full page capture, returns `CaptureResult`
  - `executeInBrowser(url, endpoint)` — execute endpoint in Chrome context
  - `triggerAndIntercept(url, endpoint)` — navigate then intercept specific network call
  - `executeActionSequence(steps)` — replay DOM action sequences (click, fill, etc.)
- Concurrency: tab semaphore (`MAX_CONCURRENT_TABS = 3`), 90s hard timeout per capture
- Kuri tab lifecycle: `acquireTabSlot()` then `kuri.navigate()` then HAR collection then `releaseTabSlot()`
- Location: `src/capture/index.ts`

**Reverse Engineer (`src/reverse-engineer/index.ts`):**
- Purpose: Parse raw HAR entries from a capture into typed `EndpointDescriptor[]`
- Key function: `extractEndpoints(requests, html, context)` — filters noise (analytics, static assets, infrastructure), extracts headers, query params, body, infers URL templates with `{placeholder}` syntax
- Strips sensitive headers (`cookie`, `authorization`, `x-csrf-token`, etc.) before storing
- Infers schema via `inferSchema()` from response payloads
- LLM-grounded descriptions via `groundedDescription()` (`src/reverse-engineer/description-prompt.ts`)
- Bundle scanner: `src/reverse-engineer/bundle-scanner.ts` — extracts route paths from JS bundles
- Location: `src/reverse-engineer/index.ts`

**Execution (`src/execution/index.ts`):**
- Purpose: Execute a known endpoint from a `SkillManifest` against a real website
- Key functions:
  - `executeSkill(skill, endpointId, params, options)` → `ExecutionResult`
  - `executeEndpoint(endpoint, params, options)` → raw execution
  - `rankEndpoints(endpoints, intent)` → sorted `RankedEndpoint[]`
  - `buildCanonicalDocumentEndpoint()` — synthesizes page-artifact endpoints
- Execution strategies per endpoint (stored in `endpoint.exec_strategy`):
  - `"server"` — direct HTTP fetch from Node process
  - `"trigger-intercept"` — navigate browser, intercept network response
  - `"browser"` — full browser execution with DOM extraction
- Projection + transform: `applyProjection()`, `inferSchema()`, `detectSchemaDrift()`
- Search form detection: `isStructuredSearchForm()` in `src/execution/search-forms.ts`
- Location: `src/execution/index.ts`

**Graph (`src/graph/index.ts`):**
- Purpose: Model skill endpoints as a directed operation graph (DAG)
- Key concepts: `SkillOperationGraph`, `SkillOperationNode`, `SkillOperationEdge`
- Key functions:
  - `buildSkillOperationGraph(skill)` — builds operation nodes with `requires`/`provides` bindings
  - `getSkillChunk(skill, options)` — returns runnable operations given known bindings
  - `computeReachableEndpoints(graph, knownBindings)` — topological reachability
  - `ensureSkillOperationGraph(skill)` — memoized graph construction
- DAG planner: `src/graph/planner.ts` — `fetchDagAdvisoryPlan()`, `applyDagAdvisoryBoosts()`
- Agent augmentation: `src/graph/agent-augment.ts` — LLM-enriches endpoint semantics
- Trace store: `src/graph/trace-store.ts` — persists execution traces by intent

**Marketplace (`src/marketplace/index.ts`):**
- Purpose: Thin facade over `src/client/index.ts` for skill CRUD. Adds local pre-cache on publish.
- Operations: `listSkills()`, `getSkill()`, `publishSkill()`, `mergeEndpoints()`, `updateEndpointScore()`
- Pre-cache: `publishSkill()` writes to local cache immediately before attempting remote publish (handles eventual consistency lag)

**Client (`src/client/index.ts`):**
- Purpose: All communication with the cloud backend (`https://beta-api.unbrowse.ai`). Also manages local config, registration, skill cache, and execution telemetry.
- Local config: `~/.unbrowse/config.json` (api_key, agent_id)
- Skill cache: `~/.unbrowse/skill-cache/` (disk-backed skill manifests)
- Profile support: `UNBROWSE_PROFILE` env var → `~/.unbrowse/profiles/<name>/`
- Key functions: `ensureRegistered()`, `searchIntentResolve()`, `getSkill()`, `publishSkill()`, `recordExecution()`, `recordOrchestrationPerf()`
- Local-only mode: `UNBROWSE_LOCAL_ONLY=1` skips all remote calls

**Kuri Client (`src/kuri/client.ts`):**
- Purpose: HTTP client wrapper for the Kuri Zig binary. Kuri is a CDP broker (464 KB, 3ms cold start).
- Protocol: All browser ops go through HTTP to `http://127.0.0.1:7700`
- Binary discovery order:
  1. `KURI_BIN` env var
  2. `packages/skill/vendor/kuri/<target>/kuri` (bundled with npm package)
  3. Monorepo `vendor/kuri/<target>/kuri`
  4. System PATH
- Platform targets: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`
- Key operations: `start()`, `stop()`, `health()`, `navigate(tabId, url)`, `getHar(tabId)`, `action(tabId, type, selector, value)`, `getCookies(tabId, domain)`, `setCookies(tabId, cookies)`
- CRITICAL: Do not modify `src/kuri/client.ts` without explicit instruction — fragile CDP coupling

**Auth (`src/auth/`):**
- `src/auth/index.ts` — `interactiveLogin(url)`: opens visible Chrome via Kuri, polls for cookie changes, stores to vault
- `src/auth/browser-cookies.ts` — `extractBrowserCookies(domain)`: reads Chrome/Firefox SQLite cookie DBs directly (no browser launch needed), decrypts Chrome cookies using macOS keychain AES key
- `src/auth/runtime.ts` — `LocalAuthRuntime`: in-memory session store for auth state during a session; `authRuntime` singleton exported
- Profile dirs: `~/.unbrowse/profiles/<registrableDomain>` (dedicated Chrome profile per domain)

**Vault (`src/vault/index.ts`):**
- Purpose: Secure credential storage
- Primary: `keytar` (OS keychain — macOS Keychain, Linux Secret Service, Windows Credential Manager)
- Fallback: AES-256-CBC encrypted JSON file at `~/.unbrowse/credentials.enc.json`
- Operations: `storeCredential(key, value)`, `getCredential(key)`, `deleteCredential(key)`

**Transform (`src/transform/`):**
- `src/transform/index.ts` — `applyProjection()`, `inferSchema()`, `buildEntityIndex()` (LinkedIn/Facebook normalized APIs)
- `src/transform/drift.ts` — `detectSchemaDrift()` — detects when endpoint schema changed since last capture
- `src/transform/schema-hints.ts` — `generateExtractionHints()` — LLM-inferred extraction hints for intent-specific field selection

**Verification (`src/verification/index.ts`):**
- Purpose: Periodic background re-verification of stored skills against live endpoints
- Called on server startup via `schedulePeriodicVerification()`

**Rate Limiter (`src/ratelimit/index.ts`):**
- Fastify plugin, applied per-route via `ROUTE_LIMITS` config object
- Protects `/v1/intent/resolve`, `/v1/skills/:id/execute`, `/v1/auth/login`

---

## Data Flow

**Full resolve-and-execute flow:**

1. Agent/CLI calls `POST /v1/intent/resolve` with `{ intent, url, params }`
2. `src/api/routes.ts` → `resolveAndExecute(intent, params, context, projection, options)`
3. Orchestrator checks caches in priority order (route-result → route → domain → local snapshot)
4. On cache miss: `searchIntentResolve(intent, domain)` → marketplace semantic search → returns top-K skill IDs
5. `getSkillWithTimeout(skillId)` for each candidate — hydrates `SkillManifest` from local cache or backend
6. `rankEndpoints(skill.endpoints, intent)` → selects best endpoint
7. `executeSkill(skill, endpointId, params)` → `executeEndpoint()`:
   - Strategy `"server"`: direct `fetch()` with injected cookies from vault
   - Strategy `"trigger-intercept"`: `triggerAndIntercept()` in Kuri Chrome tab
   - Strategy `"browser"`: `executeInBrowser()` + DOM extraction
8. Result projected via `applyProjection()`, schema inferred, drift detected
9. Cache populated; `recordExecution()` + `recordOrchestrationPerf()` fire-and-forget to backend
10. Response: `{ result, skill, trace, timing, available_endpoints, extraction_hints }`

**Live capture flow (cache miss + no marketplace hit):**

1. `captureSession(url)` → acquire tab slot → `kuri.navigate(tabId, url)` → wait for DOM content loaded
2. Kuri collects HAR entries (all network requests) via CDP Network domain
3. `extractEndpoints(har, html, jsBundle)` → filter → template → describe → `EndpointDescriptor[]`
4. `augmentEndpointsWithAgent()` — LLM enriches semantic metadata
5. `publishSkill(draft)` → local cache write → async backend publish
6. `resolveAndExecute` continues with the newly captured skill

**Auth flow:**

1. `POST /v1/auth/login` → `interactiveLogin(url)` in `src/auth/index.ts`
2. Stops any headless Kuri/Chrome; re-launches in visible (non-headless) mode
3. Navigates to login URL; polls every 2s for cookie changes (up to 5 minutes)
4. On login detected: `storeCredential(domain, cookies)` in vault
5. Subsequent `executeEndpoint()` calls: `getCredential(domain)` → inject as `Cookie` header into Kuri Chrome via `kuri.setCookies()`

Alternatively `POST /v1/auth/steal` → `extractBrowserCookies(domain)` reads existing Chrome SQLite DB directly (requires `autoExtract: true` — must not be set to false).

---

## Entry Points

**`src/index.ts`:**
- Role: Server process entrypoint (npm package mode)
- Invoked by: `node`/`bun src/index.ts` or spawned by CLI auto-start
- Responsibilities: loads `.env`, installs PID cleanup, calls `startUnbrowseServer()`, handles SIGTERM/SIGINT

**`src/cli.ts`:**
- Role: CLI entrypoint; calls local server over HTTP
- Invoked by: `unbrowse <command>` (global install) or `bun src/cli.ts`
- Responsibilities: parse args, call `ensureLocalServer()` to auto-start if needed, dispatch HTTP calls

**`src/single-binary.ts`:**
- Role: Bun compiled single-binary entrypoint (`bun --compile`)
- Modes:
  - `unbrowse serve` → run server inline (same process, no spawn)
  - `unbrowse <command>` → delegate to `src/cli.js`
- Kuri discovery: resolves vendored binary alongside the executable, caches to `~/.unbrowse/bin/kuri`

---

## Single-Binary vs npm Package Mode

| Aspect | npm Package Mode | Single-Binary Mode |
|---|---|---|
| CLI entrypoint | `src/cli.ts` via `node`+`tsx` or `bun` | `src/single-binary.ts` compiled with `bun --compile` |
| Server spawn | CLI spawns `node src/index.ts` as detached process | CLI re-execs itself with `"serve"` arg |
| Kuri discovery | `packages/skill/vendor/kuri/<target>/kuri` | Alongside binary, then `~/.unbrowse/bin/kuri` |
| Detection | `isCompiledBinary()` checks `process.argv[1]` extension | Same function returns `true` |

---

## Server Lifecycle

1. CLI calls `ensureLocalServer(baseUrl, noAutoStart, metaUrl)` in `src/runtime/local-server.ts`
2. Reads PID file at `~/.unbrowse/run/server-127.0.0.1-6969.json`
3. If PID alive and `/health` responds: version check, optionally restart if stale
4. If no PID or stale: `spawnServer()` — detached child process with stdout/stderr redirected to `~/.unbrowse/logs/server-autostart.log`
5. Polls `GET /health` every 500ms until healthy (up to configurable timeout)
6. Server writes PID file atomically on startup; clears it on exit via `process.on("exit")`

---

## Error Handling

**Strategy:** Fail-fast at boundaries, best-effort in background tasks

**Patterns:**
- Background tasks (`recordExecution`, `recordOrchestrationPerf`, `queuePassiveSkillPublish`) use `.catch(() => {})` — never block user response
- Browser captures: 90s hard `AbortSignal` timeout per capture phase via `withBrowserPhaseTimeout()`
- Kuri spawn: 3 retries with 1s backoff before throwing
- HAR entries: always `entry.request.headers ?? []` (guarded, never bare access)
- `kuri.getCurrentUrl()` / `kuri.getPageHtml()` return values validated before use (guard against `"[object Object]"` CDP shape bugs)

---

## Cross-Cutting Concerns

**Logging:** `src/logger.ts` — `log(namespace, message)`, writes to stderr with `[namespace]` prefix. No structured logging framework.

**Telemetry:** `src/telemetry.ts` — `emitRouteTrace()` — fires anonymized trace events to backend after each orchestration

**Lifecycle Attribution:** `src/runtime/lifecycle.ts` — `attributeLifecycle(events)` — aggregates per-phase durations (discover, capture, resolve, execute, publish) for perf reporting

**Domain Canonicalization:** `src/domain.ts` — `getRegistrableDomain(url)` — strips subdomains for cache key normalization

**Backend URL:** Always `https://beta-api.unbrowse.ai` (not `api.unbrowse.ai`). Overridable via `UNBROWSE_BACKEND_URL`.

---

*Architecture analysis: 2026-04-01*
