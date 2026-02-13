# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added frontend marketplace analytics-page hard-hide (route + nav link removed) for production user flows.
- Intent-based endpoint grouping/pruning for `unbrowse_capture` via `intent` + `maxEndpoints`
- Endpoint-intent selector heuristics + tests (`intent-endpoint-selector.ts`)
- Marketplace async publish + polling endpoints (`POST /marketplace/publish`, `GET /marketplace/publish/:jobId`) to avoid Cloudflare timeouts
- Browser header profiler for capturing and replaying site-specific headers from Node.js (`header-profiler.ts`)
- Frequency-based header template system — captures headers appearing on >= 80% of requests to a domain
- Header classification engine: `protocol`, `browser`, `cookie`, `auth`, `context`, `app` categories
- `resolveHeaders()` merges template + endpoint overrides + auth + cookies into a full header set
- `primeHeaders()` connects to Chrome via Playwright CDP to capture fresh cookies and header values
- Cookie priming from browser sessions — `primeHeaders()` returns `PrimeResult { headers, cookies }`
- `headers.json` written to skill directory during skill generation
- Generated `api.ts` client automatically loads and uses `headers.json` for replay
- Sanitized header profiles included in marketplace skill publish payload (auth values stripped)
- `sanitizeHeaderProfile()` function to strip auth header values before publishing
- Per-endpoint header overrides for headers that differ from domain-wide common set
- Node mode as default for `resolveHeaders()` — skips context headers to avoid TLS fingerprint mismatch
- Production benchmark eval against 1,555 marketplace skills (`production-benchmark.ts`)
- Capture-replay eval across 10 real websites with 6 header strategies (`capture-replay-eval.ts`)
- Comprehensive benchmark report with before/after comparison (`docs/benchmark-report.md`)
- 110+ unit and integration tests for header profiler pipeline
- Server proxy integration contract documentation for header profile usage
- Auto-routing skill for OpenClaw — agent automatically uses unbrowse when user asks to interact with any website's API
- Plugin skill registration via `openclaw.plugin.json` `skills` field — unbrowse instructions injected into agent prompt
- Auto-launch headless Chromium for replay when no browser is running — `execInChrome` is now the default path everywhere
- Plugin telemetry opt-out support
- Plugin account wallet-link request support
- Marketplace frontend endpoint explorer in skill detail (`/skill/:id`) using `/marketplace/skills/:id/endpoints`

### Changed
- `unbrowse_capture` now defaults `crawl=false` (crawl is opt-in)
- License metadata/docs reverted to `AGPL-3.0-only`
- `parseHar()` now always generates `headerProfile` on the returned `ApiData` object
- `execViaFetch` in `unbrowse_replay.ts` now uses `resolveHeaders()` + primed cookies by default
- Skill publish payload (`PublishPayload`) includes optional `headerProfile` field
- Skill install writes `headers.json` alongside `SKILL.md` and `auth.json`
- Plugin runtime switched to native CDP + `playwright-core`
- Plugin marketplace metadata refreshed
- Default `autoContribute` enabled in plugin manifest
- Marketplace frontend cards now show endpoint counts in browse and search views
- Frontend now routes API calls through `VITE_API_BASE` via shared `api-base` helper (marketplace + app flows)
- Removed frontend email/google login flows and legacy auth-context pages; web app now runs without frontend login/auth routes
- Removed wallet/email account funnel; marketplace publish + endpoint execution no longer require login auth
- Marketplace proxy bundles are now precomputed at ingest/publish time (no LLM work on download requests)
- CI: web app deployment Dockerized for staging/prod SSH workflows
- Documentation refresh for plugin auth/login behavior and agent notes

### Fixed
- Endpoint override domain resolution — keys now include domain to prevent cross-domain confusion
- TLS fingerprint mismatch detection — sending Chrome User-Agent from Node.js no longer triggers anti-bot (context headers excluded in node mode)
- Plugin auto-discovery and auth flows now fallback cleanly when browser tooling/CDP is unavailable
- Plugin auto-publish now verifies/prunes invalid GET endpoints before publish
- `unbrowse_replay` now applies `references/TRANSFORMS.json` (method/path transforms) so HTML endpoints can return structured JSON; `storeRaw=true` still saves full raw responses under `replays/`
- Marketplace quality gate now keeps HTML endpoints when a transform exists, auto-attaches a safe default HTML->JSON transform per endpoint (even for mixed API + SSR skills), and persists LLM-upgraded transforms at ingest (saved into `TRANSFORMS.json`)
- Stabilized OpenClaw CDP + backend tracing interactions
- Reduced brittle legacy browser API usage and added auto-publish backoff
- Marketplace frontend endpoint radar now prefers explainable `operationName()` + description instead of proxy UUID paths
- CI: web Docker build now works when lockfile is absent
- Added `127.0.0.1` local origins to backend CORS/trusted-origins allowlists (3000/3001/5173/4111)
- Fixed staging backend request timeouts caused by session auth lookups during request middleware/ingestion paths
- Production benchmark: exclude `kemono.party` from fetched production skill set

## [0.5.5] - 2026-02-13

### Added
- Added frontend marketplace analytics-page hide for non-exposed deployments.

### Changed
- Made `node-libcurl-ja3` optional across server replay/fetch paths; when unavailable, shared fetch and ability execution fallback to standard fetch behavior without failing startup/tests.
- Added regression tests for CORS origin handling and HTML-quality-gate behavior (`tests/unit/origins-cors.test.ts`, `tests/unit/quality-gate-html-transform.test.ts`).

### Fixed
- Fixed runtime crash caused by hard failure when native `node-libcurl-ja3` bindings are missing.
- Ensured marketplace replay quality-gate checks do not block HTML endpoints when a transform is attached.

## [0.5.4] - 2026-02-07

### Fixed
- Wrap Solana native imports in try/catch for Node v24/v25 compatibility
- Check process.title in isDiagnosticMode() for openclaw-doctor
- Deadlock with doctor/security audit commands
- Reduce agent context injection noise

## [0.5.3] - 2026-02-05

### Added
- FDRY token economy — rewards, execution, API routes (feature-flagged)
- Telemetry events endpoint (`POST /telemetry/events`)
- E2E tests for collaborative skill system
- Wallet integration for skill publishing and staking
- Frontend FDRY token economy UI

### Fixed
- CORS: allow localhost:3001 and staging-index.unbrowse.ai origins

### Changed
- OOP refactor of HAR parser with route generalization and schema capture
- Integrated LLM describer for rich endpoint documentation in skill generation

[Unreleased]: https://github.com/lekt9/unbrowse-openclaw/compare/v0.5.5...HEAD
[0.5.5]: https://github.com/lekt9/unbrowse-openclaw/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/lekt9/unbrowse-openclaw/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/lekt9/unbrowse-openclaw/compare/v0.5.2...v0.5.3
