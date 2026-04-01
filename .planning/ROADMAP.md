# Unbrowse v1 Roadmap

## Project

Passive browser replacement for AI agents. Agents install unbrowse and get structured API access to any site — invisible capture, shared marketplace, no adapters needed.

**Working branch:** `rach/restart-base`
**Last updated:** 2026-04-01

---

## Phases

- [x] **Phase 1: Passive Capture Foundation** — Wire kuri's builtin extension into the capture pipeline; intercept real browser traffic with response bodies
- [x] **Phase 2: Background Indexing and Cache-First Resolution** — Reverse-engineer passively observed traffic in the background; skip re-capture on second visit
- [x] **Phase 3: Browser Replacement API** — Drop-in interface so agents use unbrowse instead of Playwright/Puppeteer; UI action support when kuri hook lands
- [x] **Phase 4: Endpoint Graph** — Track endpoint relationships; prefetch related endpoints so agents get complete context in one round-trip
- [ ] **Phase 5: Marketplace Wiring and Telemetry** — Connect graph DB to marketplace for cross-agent skill sharing; auto-file GitHub issues from agent telemetry
- [ ] **Phase 6: Marketplace Payments** — Wallet-based payments so skills can be monetized and consumed by other agents

---

## Phase Details

### Phase 1: Passive Capture Foundation

**Goal**: Agents can browse through unbrowse and every API call made by the real browser is intercepted and recorded — with response bodies — without any explicit capture step.

**Depends on**: Nothing (brownfield foundation — kuri's `adding-extensions` branch is the integration point)

**Requirements**: PASSIVE-01, PASSIVE-02

**Success Criteria** (what must be TRUE):
  1. An agent navigating to any URL through unbrowse causes network API traffic to be observed by chrome.webRequest without the agent triggering any explicit capture command
  2. Response bodies are captured (not just URLs and headers) via CDP supplementation, resolving the HAR body gap
  3. The JS interceptor is injected via `Page.addScriptToEvaluateOnNewDocument` so early SPA API calls (first-paint hydration) are not missed
  4. Captured traffic from the passive observer reaches the existing `extractEndpoints` pipeline and produces `EndpointDescriptor[]`

**Plans**: 2/2 complete (01-01: scriptInject wiring, 01-02: extension data + merge pipeline)

**Notes**: PASSIVE-02 is the kuri builtin extension integration point. The `adding-extensions` kuri branch adds chrome.webRequest + CDP agent bridge (`window.__kuri`). HAR body gap requires CDP supplement — this is the core technical problem of Phase 1.

---

### Phase 2: Background Indexing and Cache-First Resolution

**Goal**: Passively observed traffic is reverse-engineered into skills in the background without blocking the agent's navigation; subsequent visits to the same site resolve from cache with no re-capture.

**Depends on**: Phase 1 (passive capture must be producing `EndpointDescriptor[]`)

**Requirements**: PASSIVE-03, PASSIVE-04

**Success Criteria** (what must be TRUE):
  1. An agent browsing site A while a background indexing job runs on site A's captured traffic observes no measurable latency increase (indexing does not block navigation)
  2. A second `resolve` call to any previously-visited site returns a skill from local cache without launching kuri or calling the marketplace
  3. Cache-first resolution falls through to marketplace lookup on local miss, and only launches live capture as a last resort
  4. Skills built from passively captured traffic are functionally equivalent to skills built from the existing active capture flow (endpoints execute and return structured data)

**Plans**: 2/2 complete (02-01: background indexing queue, 02-02: wire indexer + cache-first resolution)

---

### Phase 3: Browser Replacement API

**Goal**: Agents can swap out Playwright/Puppeteer for unbrowse and get the same navigation and action primitives — with passive capture happening invisibly underneath.

**Depends on**: Phase 2 (skills must be cached before the browser replacement layer is useful)

**Requirements**: BROWSER-01, BROWSER-02

**Success Criteria** (what must be TRUE):
  1. An agent written against the standard browser API (navigate, click, fill, submit) works identically when pointed at unbrowse, with no code changes required beyond the import/init
  2. A navigation call to a site with a cached skill does not open a browser tab — it resolves via the skill execution path
  3. A navigation call to an uncached site opens a kuri tab, passively captures traffic, and returns the page result — the agent is unaware capture happened
  4. UI actions (click, fill form, trigger POST) execute correctly when the kuri UI action hook is available (BROWSER-02 delivery from Rach); unbrowse degrades gracefully to skill execution when the hook is not yet available

**Plans**: 2/2 complete (03-01: Browser/Page API + skill-first navigation, 03-02: live capture fallback + conditional UI actions)

**Notes**: BROWSER-02 is externally blocked on Rach delivering the kuri-side UI action hook. Phase 3 ships BROWSER-01 fully and BROWSER-02 conditionally. Design the API surface for BROWSER-02 now so integration is mechanical once the hook arrives.

---

### Phase 4: Endpoint Graph

**Goal**: Unbrowse understands which endpoints depend on each other and uses that knowledge to prefetch related data in a single round-trip, so agents stop making multiple resolve calls to get complete context.

**Depends on**: Phase 2 (skills with endpoints must exist in cache; graph builds on existing `src/graph/` layer)

**Requirements**: GRAPH-02, GRAPH-01

**Success Criteria** (what must be TRUE):
  1. After a skill is captured, its endpoints are connected in a dependency graph showing parent/child, pagination, and auth dependencies
  2. An agent resolving a list endpoint receives the graph's recommended detail endpoint prefetched alongside, without making a second resolve call
  3. The dependency graph is persisted with the skill manifest and survives server restarts
  4. Agent-visible `available_endpoints` in the resolve response reflects the graph's reachability analysis given known bindings, not just a flat list

**Plans**: 2/2 complete (04-01: dependency graph construction, 04-02: prefetch integration + graph-aware resolve)

---

### Phase 5: Marketplace Wiring and Telemetry

**Goal**: Skills discovered by any agent are published to the shared marketplace and discoverable by all agents; errors agents hit in production automatically file actionable GitHub issues.

**Depends on**: Phase 2 (skills must exist before marketplace makes sense), Phase 4 (graph structure should be published alongside skills)

**Requirements**: MARKETPLACE-01, TELEMETRY-01

**Success Criteria** (what must be TRUE):
  1. A skill captured by agent A is discoverable by agent B on a different machine via marketplace semantic search within 60 seconds of first capture
  2. An agent resolving an intent with no local skill finds and successfully executes a skill published by a different agent
  3. When an agent encounters an unhandled error or unexpected behavior, a GitHub issue is automatically filed with the request context, error trace, and kuri version — without any manual action from the developer
  4. Auto-filed issues contain enough signal to reproduce the bug (intent, URL, endpoint ID, error message, kuri version)

**Plans**: TBD

---

### Phase 6: Marketplace Payments

**Goal**: Skill creators can earn from their discoveries; agents pay for skill usage via a simple wallet system.

**Depends on**: Phase 5 (marketplace must be wired before payments are meaningful)

**Requirements**: MARKETPLACE-02

**Success Criteria** (what must be TRUE):
  1. An agent with a funded wallet can consume a paid skill from the marketplace and the skill creator's wallet is credited
  2. An agent with an empty wallet receives a clear error before consuming a paid skill, with instructions to fund
  3. Skill owners can set a price per execution; free skills remain free
  4. Payment transactions are recorded and visible to both consumer and creator

**Plans**: 1/? in progress (06-01: payment gate wiring)

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Passive Capture Foundation | 2/2 | Complete | 2026-04-01 |
| 2. Background Indexing and Cache-First | 2/2 | Complete | 2026-04-01 |
| 3. Browser Replacement API | 2/2 | Complete | 2026-04-01 |
| 4. Endpoint Graph | 2/2 | Complete | 2026-04-01 |
| 5. Marketplace Wiring and Telemetry | 0/? | Not started | - |
| 6. Marketplace Payments | 1/? | In Progress | - |

---

## Coverage

| Requirement | Phase | Notes |
|-------------|-------|-------|
| PASSIVE-01 | Phase 1 | Core passive network capture |
| PASSIVE-02 | Phase 1 | Kuri extension integration — entry point |
| PASSIVE-03 | Phase 2 | Background indexing without blocking |
| PASSIVE-04 | Phase 2 | Cache-first resolution loop |
| BROWSER-01 | Phase 3 | Drop-in browser replacement API |
| BROWSER-02 | Phase 3 | UI actions — externally blocked on Rach's kuri hook |
| GRAPH-02 | Phase 4 | Dependency graph (must precede prefetch) |
| GRAPH-01 | Phase 4 | Dependency prefetch (builds on graph) |
| MARKETPLACE-01 | Phase 5 | Graph DB to marketplace wiring |
| TELEMETRY-01 | Phase 5 | Auto-issue creation (platform plumbing) |
| MARKETPLACE-02 | Phase 6 | Wallet payments |

**Coverage: 11/11 requirements mapped. No orphans.**
