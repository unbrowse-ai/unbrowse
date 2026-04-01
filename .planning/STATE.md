# Project State — Unbrowse v1

## Project Reference

**Core value**: Agents browse through unbrowse and get structured API access to any site — invisible capture, shared marketplace, no adapters needed.

**Working branch**: `rach/restart-base`

**Current focus**: Phase 1 — Passive Capture Foundation

---

## Current Position

| Field | Value |
|-------|-------|
| Phase | 1 — Passive Capture Foundation |
| Plan | None started |
| Status | Not started |
| Last updated | 2026-04-01 |

**Progress**:
```
[          ] Phase 1 — Not started
[          ] Phase 2
[          ] Phase 3
[          ] Phase 4
[          ] Phase 5
[          ] Phase 6
```

---

## Phase Status

| Phase | Goal | Status | Plans |
|-------|------|--------|-------|
| 1 — Passive Capture Foundation | Passive network interception with response bodies | Not started | 0/? |
| 2 — Background Indexing and Cache-First | Non-blocking indexing + cache-first resolution | Not started | 0/? |
| 3 — Browser Replacement API | Drop-in Playwright/Puppeteer replacement | Not started | 0/? |
| 4 — Endpoint Graph | Dependency graph + prefetch | Not started | 0/? |
| 5 — Marketplace Wiring and Telemetry | Cross-agent skill sharing + auto-issue filing | Not started | 0/? |
| 6 — Marketplace Payments | Wallet-based skill monetization | Not started | 0/? |

---

## Key Dependencies and Blockers

| Item | Type | Details |
|------|------|---------|
| Kuri `adding-extensions` branch | External dependency | Phase 1 integration point — chrome.webRequest + CDP agent bridge |
| BROWSER-02 kuri hook | External blocker | Rach delivering UI action hook; BROWSER-01 ships first, BROWSER-02 when ready |
| HAR body gap | Known technical problem | Kuri HAR records URLs+headers but not response bodies; CDP supplement required in Phase 1 |
| `main` branch broken | Branch constraint | All work on `rach/restart-base`; never merge from or rebase onto main |

---

## Accumulated Context

### Key Decisions (from PROJECT.md)

| Decision | Rationale |
|----------|-----------|
| Passive capture over active navigation | Active capture fights the browser (cookie injection, headless detection, timing races). Passive observes what the real browser actually does. |
| Kuri builtin extension as capture source | chrome.webRequest already observes all traffic; supplement with CDP for response bodies |
| Marketplace payments deferred after passive capture | Browser replacement is the viral moment; payments are the monetization layer |
| Login-as-dependency deferred to v2 | Cookie extraction from existing sessions covers most use cases for launch |

### Critical Footguns (from CLAUDE.md + CONCERNS.md)

- Never edit `src/kuri/client.ts` without explicit instruction
- Always kill running unbrowse server after `npm i -g` (`pkill -9 -f 'unbrowse|kuri'`)
- `autoExtract` must be `true` in `executeBrowserCapture` cookie resolution
- HAR entry iteration: always `entry.request.headers ?? []`, never bare access
- Guard `kuri.getCurrentUrl` and `kuri.getPageHtml` return values (can return `"[object Object]"`)
- No mocking in tests — real endpoints, real files, real functions only
- Backend URL is `beta-api.unbrowse.ai`, not `api.unbrowse.ai`

### High-Severity Concerns to Address in Phase 1

- HAR does not capture response bodies — JS interceptor + CDP supplement required
- JS interceptor injection race on navigation — fix with `Page.addScriptToEvaluateOnNewDocument` (`kuri.scriptInject` exists but is unused in `captureSession`)
- Headless Chrome detection by major sites — additional CDP stealth patches needed

### High-Severity Concerns to Address in Phase 2+

- Authenticated SPA capture: cookie injection insufficient for modern SPAs — `triggerAndIntercept` is the right direction
- `autoExtract` conditional in `executeEndpoint` silently skips cookie extraction for skills missing `auth_profile_ref`
- Stale server process after `npm i -g`

---

## Session Continuity

**To resume**: Read `.planning/ROADMAP.md` for current phase goals and success criteria. Read `.planning/STATE.md` (this file) for current position and blockers. Check git log on `rach/restart-base` for recent progress.

**Next action**: Run `/gsd:plan-phase 1` to decompose Phase 1 into executable plans.
