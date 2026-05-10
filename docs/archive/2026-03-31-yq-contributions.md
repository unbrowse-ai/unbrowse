# QA Engineering Contributions — Yong Quan Tan

**Branch:** `yq/qa-fixes` (PR #107)
**Period:** March 28-31, 2026
**Objective:** QA validation and fixes for Unbrowse deployment onto OpenClaw by April 1, 2026

## Context

Unbrowse is a tool that reverse-engineers any website's API traffic into reusable skills. The March 31 handoff requires four lanes to ship:

1. **Browser capture works reliably** — when Unbrowse visits a site, it captures API traffic
2. **Auth works** — steal cookies from the user's browser, use them on login-required sites
3. **OpenClaw integration** — the plugin that makes Unbrowse the default web tool for AI agents
4. **Payments MVP** — 402-gated skill install flow

My work focused on QA validation across all four lanes, with code fixes for issues discovered during testing. The work progressed from initial validation → bug discovery → fixes → end-to-end verification through the full Telegram → OpenClaw → Unbrowse → data pipeline.

---

## Commits (10 committed, pushed to PR #107)

### Commit 1: `cda5bc8` — feat(auth): add Comet browser support
**Date:** March 29 | **Lane:** Auth (Lane 2)

**Why this exists:** The QA machine uses Comet (Perplexity's browser) as its default browser. Cookie steal, login, and auto-detect all failed because the codebase didn't know about Comet. Without this, no auth-gated site testing was possible on this machine.

Added Perplexity Comet browser to all auth lookup tables so cookie extraction, login, and auto-detection work for users whose default browser is Comet (not Chrome). Changed 3 files, ~10 lines across 5 lookup tables:
- `BrowserSource` type, macOS Chromium candidate list (path + keychain + bundleId)
- `SUPPORTED_INTERACTIVE_BROWSERS`, `DARWIN_BROWSER_BY_BUNDLE_ID`, `MAC_BROWSER_NAME_BY_BUNDLE_ID`
- CLI usage string and error messages

**Testing:** Cookie steal verified (37 cookies from LinkedIn), auto-detect verified, `--browser comet` verified, `unbrowse login` verified. All other browsers return correct "not installed" errors — no false positives.

---

### Commit 2: `5f0d503` — fix(capture): improve interceptor timing and Performance API replay
**Date:** March 29 | **Lane:** Browser Capture (Lane 1)

**Why this exists:** During baseline testing, discovered that live capture was effectively non-functional — 11 of 14 sites got 0 intercepted requests. The 14-site suite still passed because of fallback paths (DOM extraction, seeding), but the core capture mechanism was broken. This is the most impactful fix in the branch.

Discovered that the JS fetch/XHR interceptor was missing initial page-load API calls on 11 of 14 product-success sites. Root cause: the interceptor was re-injected after a fixed 300ms sleep, but fast SPAs fire their API calls within ~50ms.

Four changes in one commit:
1. **Aggressive polling** — replaced 300ms sleep with 50ms polling loop (3s deadline) for re-injecting stealth + interceptor after navigation
2. **Performance API replay** — after collecting intercepted requests, reads Performance API for fetch/xhr URLs the interceptor missed, re-fetches them so the interceptor captures response bodies
3. **Cookie injection default** — changed `chooseCaptureAuthStrategy()` to default to cookie-injection instead of header-replay, so SPA sites get real browser cookies
4. **Auth header exclusion** — in cookie-injection mode, only set client-hint headers, not auth headers (CSRF tokens on page navigation cause HTTP 400)

**Testing:** 14/14 product-success force-capture suite passes. Intercepted requests improved from 28 → 66 total, response bodies from 8 → 42. Run 3 times to confirm stability.

**Impact before → after:**
| Metric | Before | After |
|---|---|---|
| Sites with 0 intercepted | 11/14 | 2/14 |
| Total intercepted requests | 28 | 66 |
| Total response bodies | 8 | 42 |

---

### Commit 3: `1e7d956` — docs: QA onboarding session notes and status report
**Date:** March 29 | **Lane:** All

**Why this exists:** The codebase had no QA documentation. Bugs found during testing, validated assumptions, and remaining work needed a single source of truth so nothing was lost between sessions.

Created `docs/2026-03-28-onboarding-qa-session.md` (codebase walkthrough, architecture overview, bugs found) and `docs/2026-03-29-qa-status.md` (open issues, test matrix, remaining work). These documents track verified facts vs assumptions, what's tested, and what's left.

---

### Commit 4: `57ecc46` — feat(kuri): add browser action primitive wrappers
**Date:** March 29 | **Lane:** Browser Capture (Lane 1)

**Why this exists:** Rach's handoff requires "real browser action primitives, not just passive navigation/intercept" (Lane 1 acceptance criteria). Kuri's Zig server already implements 11 action types at HTTP endpoints, but the TypeScript client had zero wrappers — making them inaccessible to the capture pipeline.

Added TypeScript wrappers for Kuri's `/action` and `/snapshot` endpoints. Kuri (the Zig-based browser engine) already implements 11 action types at the HTTP level, but the TS client had zero wrappers.

Added:
- `snapshot()` returning `SnapshotElement[]` with `ref/role/name/value`
- `action()` generic wrapper for any action type + ref + value
- `click()`, `fill()`, `type()`, `press()`, `select()`, `scroll()`, `check()`, `uncheck()`

**Testing:** `click()` verified on herokuapp.com (logout button). `fill()` and `press()` have Kuri-side bugs documented in issues #124 and #125.

---

### Commit 5: `f01d708` — test: add Kuri-based auth demo for scripted login sites
**Date:** March 29 | **Lane:** Auth (Lane 2) + Browser Capture (Lane 1)

**Why this exists:** The existing auth eval demos (`codex-auth-runner.ts`) import `agent-browser` (Playwright) which has been replaced by Kuri. The demos are completely broken — can't run at all. Needed a working auth test that proves login → cookie capture → authenticated access works end-to-end using Kuri.

Created `evals/kuri-auth-demo.ts` — a standalone auth demo using Kuri directly, replacing the broken `agent-browser` (Playwright) auth demos. Tests scripted login on 3 sites with baked-in test accounts:
- saucedemo.com (React SPA)
- the-internet.herokuapp.com (plain HTML form)
- practicetestautomation.com (standard form)

**Testing:** 3/3 pass. Uses React-compatible native input setter pattern for controlled components.

---

### Commit 6: `40cbcb8` — fix(kuri): correct press() and scroll() signatures
**Date:** March 30 | **Lane:** Browser Capture (Lane 1)

**Why this exists:** The action primitive wrappers from Commit 4 had incorrect signatures — `press()` and `scroll()` didn't require a `ref` parameter, but Kuri's `/action` endpoint requires one for all actions. Discovered during manual testing when calls silently failed.

Fixed `press()` and `scroll()` function signatures after discovering that Kuri's `/action` endpoint requires a `ref` parameter for ALL actions, including press and scroll. Found during manual testing of the action primitives.

---

### Commit 7: `3aeb259` — docs: update QA status with OpenClaw e2e findings
**Date:** March 30 | **Lane:** OpenClaw (Lane 3)

**Why this exists:** OpenClaw end-to-end testing revealed several issues that needed documenting: the plugin registered but the agent couldn't use the tool (tools.profile blocking), the Telegram channel required explicit plugin enablement, and action primitives had Kuri-side bugs. These findings needed to be captured before they were lost.

Updated the QA status document with:
- OpenClaw end-to-end findings (plugin loads, tool registers, Telegram channel works)
- Action primitive test results (click works, fill/press have Kuri bugs)
- OpenClaw setup gotchas (tools.profile blocks plugin tools, telegram plugin needs enable)
- Lane 4 confirmed unbuilt
- All browser steal results documented

---

### Commit 8: `e964725` — fix(openclaw): surface endpoint details in deferred resolve responses
**Date:** March 31 | **Lane:** OpenClaw (Lane 3)

**Why this exists:** During Telegram end-to-end testing, the OpenClaw agent called unbrowse but got back a useless "Found 2 endpoints. Pick one and call POST..." message. The agent couldn't do anything with it — no endpoint details, no descriptions, no way to know which one to execute. The user on Telegram saw cryptic "deferred result" messages. The plugin's `summarizeOutput()` was extracting only the message string and throwing away the endpoint details.

When the CLI returns a deferred "pick an endpoint" response, the plugin's `summarizeOutput()` now formats the available operations with action kinds, descriptions, requirements, and endpoint IDs so the agent can choose one and call execute on the next turn. Previously only the raw message string was returned, giving the agent nothing actionable.

**Testing:** 10/10 OpenClaw plugin tests pass. Verified via Telegram bot — agent sees endpoint list and can follow up.

---

### Commit 9: `253112c` — fix(capture): add live DOM extraction and improve interactive stimulus
**Date:** March 31 | **Lane:** Browser Capture (Lane 1)

**Why this exists:** SSR sites (crates.io, lobste.rs, LinkedIn) bake their data into HTML — there's no fetch/XHR call for the interceptor to catch. The previous capture pipeline only worked for sites that make client-side API calls. Needed a general-purpose solution that works regardless of how data arrives on the page.

Two general-purpose fixes for SSR sites where data is server-rendered into HTML (no fetch/XHR to intercept):

1. **Interactive stimulus improvement** — dispatches `InputEvent` alongside `Event` for React/Vue/Angular compatibility. Adds `keypress` event and small delays for framework state updates. Retries once on CDP transport errors.

2. **Live DOM extraction** — after browser capture, runs `kuri.evaluate()` on the rendered page to find repeated element groups (package cards, search results, feed posts). Extracts title, url, author, description, time, image from each. Wired into execution as fallback when captured API endpoints are metadata-only.

**Testing:** 14/14 product-success force-capture passes. Live DOM extraction triggered on Docker Hub (25 items), Dev.to (15 items), crates.io (10 items), lobste.rs (5 items).

---

### Commit 10: `664a637` — fix(capture): wire live DOM extraction data through orchestrator to user
**Date:** March 31 | **Lane:** Browser Capture (Lane 1) + OpenClaw (Lane 3)

**Why this exists:** Commit 9 added live DOM extraction that successfully captured data (10 items from crates.io, 25 from lobste.rs). But the data never reached the user — the orchestrator wrapped it in a "pick an endpoint" deferral every time. After mapping the full orchestrator decision tree (21 return paths, documented in `docs/2026-03-31-orchestrator-analysis.md`), identified three sequential blockers:

1. **capture/index.ts — timing fix:** `extractFromLiveDOM()` ran too late in the capture flow (after HTML fallback fetches that added seconds of latency). The 90-second capture timeout would fire and kill the browser tab before extraction ran, causing "CDP command failed." Moved the call earlier — right after the HTML snapshot, when the tab is still alive.

2. **execution/index.ts — last-chance return:** When `executeBrowserCapture` had live DOM data but reached the default return path, it returned `{learned_skill_id, endpoints_discovered}` without the data. The orchestrator then called `buildDeferralWithAutoExec` which re-executed endpoints and discarded the original data. Added a check: if we have `live_dom_extraction` and no intent-relevant API endpoints, return the data directly with `_extraction` metadata.

3. **orchestrator/index.ts — source gate:** The orchestrator's DOM-result bypass (line 3108) only allowed `source: "html-embedded"` through. Live DOM extraction uses `source: "live-dom"` — it was blocked and fell through to deferral. Added `"live-dom"` to the check. Also excluded DOM extraction endpoints from `skillHasBetterStructuredSearchEndpoint` so they don't claim to be "better" than live DOM data.

**Testing:** 14/14 product-success force-capture passes. lobste.rs returns 25 items directly (source: dom-fallback) instead of deferring.

---

## Issues Filed (4)

| Issue | Title | Priority | Status |
|---|---|---|---|
| #124 | bug(kuri): HAR recording returns 0 entries — no background CDP event reader | P0 | Closed |
| #125 | bug(kuri): /action fill and press report success but don't change DOM state | P1 | Closed |
| #175 | feat(capture): support React Server Components (RSC) wire format | P1 | Closed |
| #178 | docs(openclaw): document required config steps for unbrowse plugin activation | P1 | Closed |

---

## Test Coverage Summary

| Test Suite | Result | Runs |
|---|---|---|
| Product-success 14-site (force-capture) | 14/14 pass | 6 runs |
| Product-success 14-site (marketplace) | 14/14 pass | 1 run |
| Auth + browser-cookies unit tests | 40/40 pass | 2 runs |
| OpenClaw plugin tests | 10/10 pass | 3 runs |
| Kuri auth demo (scripted login) | 3/3 pass | 2 runs |
| All browser cookie steal | Comet pass, 8 others "not installed" (correct) | 1 run |
| OpenClaw e2e via Telegram | Pipeline connects, data returns for SSR sites | Multiple runs |

---

## Lane Status at End of Sprint

### Lane 1: Browser Capture — Significantly improved
- Interceptor coverage: 3/14 → 12/14 sites with captured traffic
- Live DOM extraction: new capability for SSR sites
- Action primitives: wrappers added (click works, fill/press have Kuri bugs)
- HAR recording: documented as broken (#124), workaround via Performance API replay

### Lane 2: Auth — Functional for Comet users
- Cookie steal, login, auto-detect all work for Comet browser
- Other browsers (Arc, Dia, Brave, Chrome) have code paths but not tested (not installed)
- LinkedIn captureSession has an unresolved orchestration bug (documented)

### Lane 3: OpenClaw — End-to-end pipeline verified
- Plugin v2.1.6 installed from local path, registered with 3 hooks
- Telegram bot connected and responding
- Agent calls unbrowse, gets data back for SSR sites
- Setup requires undocumented config steps (documented in #178)

### Lane 4: Payments — Confirmed unbuilt
- Zero code exists. Needs product decision.

---

## Key Discoveries

1. **The JS interceptor was effectively broken on main** — 11/14 sites got 0 intercepted requests due to a 300ms re-injection delay. Fixed with aggressive polling + Performance API replay.

2. **Kuri's HAR recording returns 0 entries on every site** — the Zig CDP client has no background WebSocket reader. Events pile up during page load waits and get lost. Documented in #124.

3. **SSR sites need live DOM extraction** — sites like crates.io and LinkedIn bake data into HTML. No fetch/XHR to intercept. Live DOM extraction via `kuri.evaluate()` captures the rendered content directly.

4. **The orchestrator's deferral logic has multiple interacting gates** — when live DOM extraction captures data, it must pass through conditions in both `executeBrowserCapture` (execution layer) and `resolveAndExecute` (orchestrator layer) to reach the user. Full analysis in `docs/2026-03-31-orchestrator-analysis.md`.

5. **OpenClaw's `tools.profile: "coding"` hides plugin tools** — a user following the README gets "tool not available" with no indication why. Documented in #178.

6. **React Server Components (RSC) are actively penalized** — `text/x-component` responses get -10 score and are discarded as "framework noise." Modern Next.js App Router sites lose their data. Documented in #175.
