# Onboarding & QA Session — March 28, 2026

## Participants
- Yong Quan (new engineer, QA role)
- Amp (AI agent)

## Session Goals
1. Understand the Unbrowse codebase end-to-end
2. Identify key patterns, anti-patterns, and technical debt
3. Scope QA work against Rach's March 31 handoff priorities
4. Get Kuri + CLI working locally and validate the core pipeline

---

## Part 1: Codebase Onboarding

### What Unbrowse Does

Unbrowse turns any website into a reusable API skill for AI agents. It captures network traffic via a headless browser (Kuri), reverse-engineers the real API endpoints underneath the UI, and publishes them to a shared marketplace. One agent learns a site once; every subsequent agent gets the fast path (~200ms vs 20-80s).

### Architecture Overview

**Three-tier system:**

| Tier | Stack | Purpose |
|---|---|---|
| CLI (`src/cli.ts`) | Bun/TypeScript | Shell-safe wrapper, client-side extraction (--path/--extract/--limit) |
| Local Server (`:6969`) | Fastify | Core engine: orchestration, capture, execution, auth. Proxies unmatched routes to backend |
| Backend (`beta-api.unbrowse.ai`) | Cloudflare Worker (Hono) | Shared marketplace: skill storage (KV), vector search (EmergentDB + Gemini), agent registration (Unkey) |

**Publishable package:** `packages/skill/` is the npm `unbrowse` package. Its `src/` symlinks to the monorepo root `src/`.

### Core Data Flow: `resolveAndExecute()`

The orchestrator walks through **5 cache layers** before falling back to expensive live capture:

1. **Route result cache** (in-memory Map) — exact intent+domain+url match → cached result
2. **Route skill cache** (disk-backed JSON, 24h TTL) — intent+domain → skill_id, then execute
3. **Domain skill cache** (disk-backed JSON, 7d TTL) — domain → skill_id (cross-intent reuse)
4. **Marketplace vector search** — Gemini embeddings + EmergentDB, ranked by composite score (40% similarity + 30% reliability + 15% freshness + 15% verification)
5. **Live capture** — Kuri browser → navigate → intercept traffic → reverse-engineer → publish → execute

### Module Map

| Directory | Purpose | Size/Complexity |
|---|---|---|
| `src/orchestrator/` | Decision brain — resolveAndExecute() + 5 cache layers | 1400+ lines 🔴 |
| `src/execution/` | Runs endpoints — server-fetch, browser-replay, trigger-intercept, DOM extraction | 1500+ lines 🔴 |
| `src/capture/` | Kuri tab management, HAR collection, cookie extraction, intent-aware waiting | 850+ lines 🔴 |
| `src/reverse-engineer/` | Endpoint extraction, URL templatization, secret stripping, collapse | 1200+ lines 🔴 |
| `src/graph/` | DAG builder, semantic inference, operation scoring, agent view formatting | 800+ lines 🔴 |
| `src/auth/` | Interactive login, Chrome/Firefox SQLite cookie extraction, vault storage | Moderate |
| `src/transform/` | Response projection, schema inference, drift detection, extraction hints | Moderate |
| `src/client/` | HTTP client for marketplace API | Moderate |
| `src/marketplace/` | Thin wrapper over client (publish/get/merge) | Small |
| `src/vault/` | Filesystem credential store (~/.unbrowse/) | Small |
| `src/kuri/` | Kuri (Zig CDP broker) HTTP client | Moderate |
| `src/api/` | Fastify route handlers + catch-all proxy to backend | Moderate |
| `src/types/` | Core types: SkillManifest, EndpointDescriptor, ExecutionTrace | Small |
| `backend/` | Cloudflare Worker (Hono) — marketplace, vector search, agent registration | Moderate |
| `frontend/` | Next.js marketing/landing page | Separate |
| `packages/skill/` | Publishable npm `unbrowse` CLI package (symlinks src/ to root) | Packaging |

### Key Patterns (What Works Well)

1. **Strong domain model** — `SkillManifest` → `EndpointDescriptor[]` → `SkillOperationGraph` is the right center of gravity. Every subsystem speaks the same contract.

2. **Progressive fallback pipeline** — The orchestrator's resolution order (result cache → route cache → domain cache → marketplace → live capture → DOM fallback) is well-designed for dealing with flaky sites, auth, and eventual consistency.

3. **Local-first resilience** — Pre-caching on publish, read-after-write avoidance, disk-backed caches. System feels fast even when the backend/indexer lags.

4. **Security guardrails at the right layer** — Reverse-engineer strips sensitive headers (`STRIP_HEADERS`, `SENSITIVE_QUERY_PARAMS`) before endpoints are stored. Quality validation gates marketplace publishing.

5. **Operational introspection** — Version-stamped traces, timing breakdowns (`OrchestrationTiming`), feedback capture, drift detection, debug/session logs.

### Anti-Patterns & Technical Debt

| Anti-Pattern | What Likely Happened | Consequence | What Could Be Better |
|---|---|---|---|
| **God modules** (orchestrator 1400L, execution 1500L, capture 850L, reverse-engineer 1200L, graph 800L) | Fast product iteration — heuristics landed where easiest to add | Hard to reason locally, high merge-conflict rate, tests need whole-world setup, hidden invariants | Keep façade functions, split by responsibility: policy/state/I/O/presentation |
| **Cache sprawl + hidden global state** (5 Maps + 2 disk files + setInterval at import time) | Needed speed and protection from marketplace lag | Nobody knows the source of truth, stale behavior hard to debug, state leaks across requests/tests | Central typed `ResolutionCache` service with explicit TTLs, provenance, invalidation |
| **Execution mixes data-plane and control-plane** | Convenient to add "if 401, refresh auth; if new, publish to marketplace" inline | Simple execution triggers browser launches, marketplace publishes, schema backfills, vault writes | Separate `executeEndpoint()` (pure data-plane) from learn/publish/schema-update |
| **Graph module does 3 things** (semantic matching, DAG planning, agent UI formatting) | Same data needed for all three | Change to description breaks planning; can't unit-test planner independently | Split into `semantic.ts`, `planner.ts`, `view.ts` |
| **Two web frameworks without shared contracts** (Fastify local + Hono backend) | Local needs Node/browser state; backend needs Workers edge | Auth, errors, serialization can drift silently | Share handler/service layer and request/response schemas |
| **CLI owns business logic** (URN resolution, entity indexing, path extraction — 150 lines in cli.ts) | Needed transforms for shell users | Non-CLI consumers don't get same behavior | Move to shared `projection/` module |
| **Marketplace module too thin** — 4 wrappers that delegate to `client/` | Attempt at domain boundary | Ambiguous ownership: call `client` or `marketplace`? | Either make it the real boundary or remove it |
| **Inline third-party calls in routes.ts** (/v1/stats calls npm/GitHub/Unkey APIs inline) | Quick dashboard feature | Route handler becomes integration logic, no timeout/retry | Extract `StatsService` |
| **Import-time side effects** (setInterval, cache load from disk, pkill chrome at startup) | Pragmatic ops shortcuts | Surprising in tests/dev, fragile embedding | Move to explicit `bootstrap()` functions |
| **Heuristic sprawl without registry** (site-specific rules scattered across capture, reverse-engineer, auth) | Inherent to domain — heuristics accumulate where browser code lives | Adding new site means touching 3-4 files inline | Registry/plugin pattern: `heuristics/discord.ts`, `heuristics/linkedin.ts` |

### Architectural Risks

1. **Dependency gravity** — `execution` imports 12 modules, `orchestrator` imports 10. Don't add new responsibilities to these files.
2. **Runtime boundary leakage** — `packages/skill/` symlinks root `src/`. Node-only and Worker-safe code can bleed.
3. **Concurrency fragility** — Global Maps + disk caches + process-level browser state. `client_scope` helps but is layered on.
4. **Sensitive data persistence** — Auth cookies, traces, captured response bodies all persist to `~/.unbrowse/`. No unified scrub/retention policy.

---

## Part 2: Scoping QA Against March 31 Handoff

### Initial Scope (Before Handoff)

Original plan was "QA top 10 skills + Kuri as default across Claude, Hermes, Codex." This turned out to be **wrong scope** after reading Rach's handoff document.

### Rach's Actual March 31 Bar

4 lanes, in priority order:

1. **Browser Action Floor** — First-pass browser execution when no reusable second-pass path exists. Real action primitives (click/fill/submit), not just passive capture. Kuri tab discovery and managed Chrome must work.

2. **Auth / Session Reuse / Browser Choice** — Explicit browser-choice contract in CLI/API. Reuse existing Chrome/Firefox sessions before forced login. Truthful reporting of which browser/profile was used.

3. **OpenClaw-First Host Integration** — OpenClaw is THE priority host (not Claude, not Hermes, not Codex). Install path must not look broken. One real host beats many half-shipped integrations.

4. **Payments MVP** — 402-gated skill install/details flow. Wallet/provider abstraction. Coinbase CDP default with swappable boundary.

### Key Insight From Handoff

> Broad host ecosystem support beyond OpenClaw is **explicitly out of scope** for March. "MCP ecosystem breadth, Hermes breadth, ElizaOS breadth, LangChain breadth" — all cut.

### Simple Rule

> If a task does not directly improve: real browser actions, real auth/session reuse, OpenClaw-first usability, payment/install MVP, or truthful docs/install surface — it is not a March 31 task.

---

## Part 3: Bugs Found & Fixed

### Bug 1: Kuri Binary Not Found During Development

**Symptom:** `Kuri binary not found at /Users/.../src/kuri/vendor/kuri/darwin-arm64/kuri`

**Root Cause:** `getPackageRoot()` in `src/runtime/paths.ts` resolves to the directory containing the calling file when `path.basename(dir)` is not `src` or `dist`. When called from `src/kuri/client.ts`, `getModuleDir()` returns `src/kuri/`, `path.basename` is `kuri` (not matching `src`), so it returns `src/kuri/` as the package root. It then looks for `vendor/kuri/darwin-arm64/kuri` relative to that — a path that doesn't exist.

The actual binary lives at `packages/skill/vendor/kuri/darwin-arm64/kuri`. This works in the published npm package (where `packages/skill/` IS the root and `vendor/` is right there) but fails in monorepo development.

**Fix Applied:** Symlinked the vendor directory:
```bash
mkdir -p src/kuri/vendor/kuri/darwin-arm64
ln -sf /path/to/packages/skill/vendor/kuri/darwin-arm64/kuri src/kuri/vendor/kuri/darwin-arm64/kuri
```

**Proper Fix Needed:** Either:
- Add `packages/skill/vendor/` to the binary candidate list in `getKuriBinaryCandidates()`
- Or fix `getPackageRoot()` to walk up to the actual monorepo root when called from nested `src/kuri/` paths
- Or set `UNBROWSE_PACKAGE_ROOT` in dev scripts

### Bug 2: Kuri CDP Port Race Condition — "No tabs available"

**Symptom:** `No tabs available and failed to create one` immediately after Kuri starts Chrome successfully.

**Root Cause:** Race condition in `kuri/client.ts` `start()` function. After Kuri launches Chrome, it prints `CDP port: 9222` to stderr. The client parses this asynchronously via a `.on("data")` handler on line 248. The old code waited only 300ms (hardcoded sleep on line 270) before calling `ensureTabsDiscovered()`. If the stderr line hadn't been flushed/parsed yet, `kuriCdpPort` was still `null`, so the `/discover` call had no `cdp_url` parameter, Kuri didn't know where Chrome was, and tabs were never registered.

**Fix Applied:** Replaced the fixed 300ms sleep with a proper wait loop (up to 5s) for the CDP port to appear:

```typescript
// Before (broken):
await new Promise((r) => setTimeout(r, 300));
if (!kuriCdpPort) await discoverCdpPort();

// After (fixed):
const cdpDeadline = Date.now() + 5_000;
while (!kuriCdpPort && Date.now() < cdpDeadline) {
  await new Promise((r) => setTimeout(r, 200));
}
if (!kuriCdpPort) await discoverCdpPort();
```

**File:** `src/kuri/client.ts` lines 268-278

### Issue 3: Chrome Not Installed

**Symptom:** Kuri starts but logs `error: no Chrome binary found on this system`. All capture/tab operations fail.

**Root Cause:** No Chromium-family browser was installed on the machine (only Safari, Discord, etc.). Kuri requires Chrome/Chromium to control via CDP.

**Onboarding Gap:** `unbrowse setup` reports `browser_engine: { installed: true, action: "already-installed" }` based solely on the Kuri binary existing. It does NOT check if Chrome is actually present. Users will hit the same wall — everything looks "set up" but nothing works.

**Resolution:** Installed Chrome via `brew install --cask google-chrome`.

**Recommended Fix:** Add a Chrome presence check to `ensureBrowserEngineInstalled()` in `src/runtime/setup.ts` or add a post-setup health check that verifies Kuri can actually create a tab.

---

## Part 4: Validation Results

### What Was Tested

| # | Test | Result | Details |
|---|---|---|---|
| 1 | `git submodule update --init --recursive` | ✅ Pass | Kuri source + OpenClaw plugin submodules pulled |
| 2 | Kuri binary discovery | 🐛 Fixed | Symlink workaround for dev path resolution |
| 3 | Kuri CDP race condition | 🐛 Fixed | Replaced 300ms sleep with proper CDP port wait |
| 4 | `bun src/cli.ts health` | ✅ Pass | Server starts, returns `{"status":"ok","trace_version":"f09fb65b8e69@2b4523d"}` |
| 5 | GitHub resolve — first pass (live capture) | ✅ Pass | 19s total: captured GitHub search, reverse-engineered `GET api.github.com/search/repositories?q={q}`, published skill, executed, returned 166K repos |
| 6 | GitHub resolve — second pass (cached) | ✅ Pass | Near-instant — marketplace/cache reuse confirmed |

### What Was NOT Tested Yet

| # | Test | Lane | Priority |
|---|---|---|---|
| 1 | Kuri capture test suite (`bun test evals/kuri-capture.test.ts`) | Lane 1 | High — validates fix across multiple sites |
| 2 | LinkedIn auth-gated resolve (the handoff canary) | Lane 1 | **Critical** — single most important acceptance gate |
| 3 | Product-success eval suite (`bun run eval:codex:product-success`) | Lane 1 | High — 14-site broad coverage |
| 4 | Chrome cookie steal without browser launch (`/v1/auth/steal`) | Lane 2 | High |
| 5 | Browser choice surface in CLI (`--browser` flag) | Lane 2 | Medium |
| 6 | Truthful auth reporting (which browser/profile was used) | Lane 2 | Medium |
| 7 | OpenClaw plugin tests (`bun run test:openclaw-plugin`) | Lane 3 | High |
| 8 | OpenClaw plugin typecheck (`bun run typecheck:openclaw-plugin`) | Lane 3 | High |
| 9 | `npx skills add unbrowse-ai/unbrowse` install path | Lane 3 | High |
| 10 | SKILL.md metadata check (`bun run check:skill-md`) | Lane 3 | Medium |
| 11 | Payments/wallet/402 code existence | Lane 4 | Low — likely doesn't exist yet |
| 12 | Browser action primitives (click/fill/submit) | Lane 1 | **Critical** — handoff says these are needed but they don't exist |

---

## Part 5: How to Run Things (Dev Reference)

### Prerequisites
```bash
# 1. Install Chrome (required — Kuri needs it)
brew install --cask google-chrome

# 2. Init submodules
git submodule update --init --recursive

# 3. Ensure Kuri binary is discoverable in dev
# (until the path resolution bug is properly fixed)
mkdir -p src/kuri/vendor/kuri/darwin-arm64
ln -sf $(pwd)/packages/skill/vendor/kuri/darwin-arm64/kuri src/kuri/vendor/kuri/darwin-arm64/kuri
```

### Running the CLI (from repo source)
```bash
# Health check
bun src/cli.ts health

# Resolve an intent (first pass = live capture, subsequent = cached)
bun src/cli.ts resolve --intent "search repositories" \
  --url "https://github.com/search?q=openai&type=repositories" --pretty

# Execute with extraction
bun src/cli.ts execute --skill {id} --endpoint {id} \
  --extract "full_name,description,stargazers_count" --limit 5 --pretty

# Interactive login for auth-gated sites
bun src/cli.ts login --url "https://www.linkedin.com"

# Submit feedback
bun src/cli.ts feedback --skill {id} --endpoint {id} --rating 5
```

### Running Tests & Evals
```bash
# Unit tests
bun run test

# Kuri capture tests
bun test evals/kuri-capture.test.ts

# Product-success eval suite (14 sites)
bun run eval:codex:product-success

# Stress eval suite (22 sites)
bun run eval:codex:stress

# OpenClaw plugin
bun run test:openclaw-plugin
bun run typecheck:openclaw-plugin

# SKILL.md sync check
bun run check:skill-md
```

### Runtime Presets
```bash
bun run preset:prod      # Uses marketplace, no force-capture
bun run preset:testing   # Force-capture mode
bun run preset:show      # Show current preset
```

---

## Appendix: Files Modified

| File | Change | Type |
|---|---|---|
| `src/kuri/client.ts` (line 268-278) | Replaced 300ms sleep with CDP port wait loop (up to 5s) | Bug fix |
| `src/kuri/vendor/kuri/darwin-arm64/kuri` | Symlink to `packages/skill/vendor/kuri/darwin-arm64/kuri` | Dev workaround |
