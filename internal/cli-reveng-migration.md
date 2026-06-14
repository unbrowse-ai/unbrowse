# CLI reverse-engineering removal — make the client binary RE-free (gated v8.0.0)

INTERNAL / moat. Gitignored. Never public.

## Goal
The compiled `unbrowse` CLI binary must carry **no reverse-engineering engine**. The
client captures + obfuscates locally and **delegates endpoint extraction to the
backend** (`/v1/reveng`, already deployed). The engine source stays in `src/reverse-engineer/`
(the backend imports it via `../../../src/reverse-engineer`); only the **client build**
must stop importing it.

## Witness (the only exit)
`bash scripts/cli-no-reveng-gate.sh` exits 0 ⇔ no client source under `src/` imports
`reverse-engineer/`. RED today: **10 imports across 7 files**. Plus: `bun test` green,
binary builds, a live `resolve`/`execute` still returns real endpoints (via backend).

NOTE: gate uses `git grep` on the real `src/` path — `packages/skill/src` is a symlink
to `../../src`, BSD grep/find don't follow it (false-green trap).

## Surface split
- **Stay client-side (sanitizers, needed to obfuscate before upload):** `isSensitiveHeader`,
  `isReplayCriticalHeader`, `extractAuthHeaders`, `extractGraphQLOperationName`. They live
  inside the 2,127-line `src/reverse-engineer/index.ts` next to the engine → must be
  **relocated** to a client-safe module with no engine dep.
- **Move to backend (moat RE):** `extractEndpoints`, `scanBundlesForRoutes`,
  `findTokenSources`/`extractTokenFrom{Html,Bundle}`/`enrichEndpointsWithTokenSources`,
  `minePathTemplates`, `buildDescriptionPrompt`/`groundedDescription`/`inferDescriptionParams`.

## Backend coverage (gap = needs route + CI deploy)
- `/v1/reveng` POST {capture:RawRequest[]} → {endpoints, holes, count}. Covers
  `extractEndpoints(capture)`. ✅ exists + wired (`backend/src/routes/reveng.ts`).
- NOT covered yet → needs backend extension + deploy:
  - `scanBundlesForRoutes(js_bundles, origin)` — execution/index.ts:1951
  - `enrichEndpointsWithTokenSources(endpoints, requests, html, jsBundles)` — api/browse-index.ts:297
  - runtime `extractTokenFrom{Html,Bundle}` — execution/token-resolver.ts (during EXECUTE)

## Server-ONLY, not server-first
`server-first.ts` keeps a local fallback → engine stays in the binary. For RE-free we need
**server-only + degrade** (no endpoints on failure), re-raise x402. New client helper:
`revengCaptureRemote(capture) → {endpoints,holes}|null` mirroring `refineExtractionRemote`.

## Phases  (STATUS as of commit 633b09b1 — gate RED, 9 leaks)
- [x] **P0 witness** — `scripts/cli-no-reveng-gate.sh` (was RED 10).
- [x] **P1 relocate sanitizers** — DONE as `src/values/header-classify.ts` (not capture/);
  the 4 sanitizers + 6 constants moved out of the engine, engine re-exports for back-compat,
  6 client sites repointed. `src/capture/index.ts` now imports ZERO engine code. Leak 10→9.
  Verified: builds, auth + graphql tests pass. (commit 633b09b1)
- [ ] **P2 client delegate helper** — `revengCaptureRemote` (server-only+degrade) in `src/client`.
- [ ] **P3 migrate `extractEndpoints` call-sites** to the helper: execution/index.ts (L5,2591),
  api/routes.ts, api/browse-index.ts, browser/index.ts, orchestrator/browser-agent.ts.
- [ ] **P4 backend extend** — add bundle-scan + token-source + token-resolve to backend routes.
- [ ] **P5 migrate the rest** — scanBundlesForRoutes, enrich…TokenSources, token-resolver.
- [ ] **P6 seal** — gate green + `bun test` + binary build + live resolve/execute; THEN bump v8.0.0.

## THE BLOCKER (why the loop can't settle this alone)
P2–P3 make the client call `/v1/reveng` server-only (no local fallback) and DROP the
`extractEndpoints` import. `/v1/reveng` exists + is wired (`backend/src/routes/reveng.ts`)
but is **execToken-gated** (only CI-signed binaries pass) and `extractEndpoints`-only —
P4/P5 (bundle-scan + token-sources routes) do NOT exist server-side yet. So a faithful
P2–P5 = backend route additions + a **production deploy** (git tag → CI), or the client
ships broken-until-deploy (fake-green, forbidden). The deploy is the user's to authorize.
P1 is the only deploy-independent slice; it is done. Everything below P1 is deploy-gated.

## Call-site reference (true paths in src/)
- src/api/browse-index.ts:10,11
- src/api/routes.ts:8 (also L150,157,1024)
- src/browser/index.ts:5 (also L80,84)
- src/capture/index.ts:5 (sanitizers only)
- src/execution/index.ts:5,6,2591 (also L1951,2117,2592)
- src/execution/token-resolver.ts:11 (L135,163)
- src/orchestrator/browser-agent.ts:13 (L266,305)
