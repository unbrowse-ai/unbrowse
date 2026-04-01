# Unbrowse — Passive Browser Replacement

## What This Is

A drop-in browser replacement for AI agents that passively reverse-engineers every website's APIs while browsing normally. First visit indexes the site's endpoints; every subsequent call uses cached skills or the shared marketplace. Agents install unbrowse and it just works — no configuration, no explicit capture step, no API documentation needed.

## Core Value

Agents browse the web through unbrowse and get structured API access to any site for free — without anyone writing adapters, scrapers, or API wrappers. The capture is invisible and the marketplace makes every agent's discoveries available to all agents.

## Requirements

### Validated

- ✓ CLI resolve/execute workflow — existing
- ✓ HAR-based endpoint discovery — existing
- ✓ Server-fetch execution for cached endpoints — existing
- ✓ Browser cookie extraction (Chrome/Firefox SQLite) — existing
- ✓ Kuri browser engine integration — existing
- ✓ Marketplace search (vector similarity) — existing
- ✓ Evaluation harness (codex-harness) — existing
- ✓ Self-contained binary build (bun --compile + kuri) — existing

### Active

- [ ] **PASSIVE-01**: Passive network capture — index all API traffic while the browser operates normally (no explicit capture step)
- [ ] **PASSIVE-02**: Kuri builtin extension integration — use chrome.webRequest observer + CDP for response body capture
- [ ] **PASSIVE-03**: Background indexing — reverse-engineer endpoints from passively observed traffic without blocking navigation
- [ ] **PASSIVE-04**: Cache-first resolution — second call to any site hits local cache or marketplace, no re-capture needed
- [ ] **BROWSER-01**: Drop-in browser replacement API — agents use unbrowse instead of Playwright/Puppeteer/agent-browser
- [ ] **BROWSER-02**: UI action support — kuri hook for clicking elements, filling forms, triggering POST requests (Rach dependency)
- [ ] **BROWSER-03**: OpenClaw native integration — replace browser in OpenClaw agent framework
- [ ] **GRAPH-01**: Dependency prefetch — resolve related endpoints together (list + detail) in a single round-trip
- [ ] **GRAPH-02**: Endpoint dependency graph — track which endpoints relate to each other for smarter resolution
- [ ] **TELEMETRY-01**: Auto-issue creation — agents auto-file GitHub issues with telemetry when hitting bugs
- [ ] **MARKETPLACE-01**: Wire graph DB to marketplace — enable publishing and discovery of skills
- [ ] **MARKETPLACE-02**: Marketplace payments — wallet-based payments for skill usage

### Out of Scope

- Fresh agent account registration (login-as-dependency) — v2 after launch
- Cross-chain/crypto payments — start simple with wallets first
- Custom rendering engine browser — Rach's separate project, not unbrowse scope
- Rewriting kuri internals — kuri is Rach's domain, we integrate with it

## Context

- **Kuri `adding-extensions` branch**: Adds Chrome extension management + builtin extension with stealth patches, network observer (chrome.webRequest), and agent bridge (window.__kuri). This is the integration point for passive capture.
- **HAR body gap**: Kuri's HAR captures URLs+headers but not response bodies on the adding-extensions branch. chrome.webRequest API limitation — need CDP supplement or in-page replay for bodies.
- **LinkedIn test case**: Current active capture fails because headless Chrome + cookie injection isn't sufficient for modern SPAs (RSC, service workers, session state beyond cookies).
- **Working branch**: `rach/restart-base` — main is broken.
- **Rach is CTO/co-founder**: Handles kuri development. Lewis manages unbrowse integration. Communication via Telegram, async agent-to-issue workflow preferred.
- **Fundraise pressure**: Need viral launch moment to close VC round faster. Marketplace + Kevin retweet is the catalyst.

## Constraints

- **Tech stack**: TypeScript/Bun monorepo, Kuri (Zig) for browser, Cloudflare Workers for backend
- **Kuri dependency**: UI action support (BROWSER-02) blocked on Rach delivering the hook
- **No kuri edits**: Never edit src/kuri/client.ts unless explicitly asked — fragile wrapper
- **No mocking**: All tests must hit real endpoints, real files, real functions
- **Branch**: All work on `rach/restart-base`, not main

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Passive capture over active navigation | Active capture fights the browser (cookie injection, headless detection, timing races). Passive observes what the real browser actually does. | — Pending |
| Kuri builtin extension as capture source | chrome.webRequest already observes all traffic. Supplement with CDP for response bodies. | — Pending |
| Marketplace payments deferred to after passive capture | Browser replacement is the viral moment; marketplace payments are the monetization layer | — Pending |
| Login-as-dependency deferred to v2 | Cookie extraction from existing sessions covers most use cases for launch | — Pending |

---
*Last updated: 2026-04-01 after initialization*
