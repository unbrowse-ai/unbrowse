# Codebase Concerns

**Analysis Date:** 2026-04-01

---

## Branch State

**`main` branch is broken — `rach/restart-base` is the working branch:**
- Issue: The `main` branch contains broken state; all active development is on `rach/restart-base`.
- Impact: Any PR targeting `main` or rebase onto `main` will corrupt the working branch.
- Fix approach: Do not merge from or rebase onto `main`. All work stays on `rach/restart-base` until a deliberate merge strategy is decided.
- Severity: **CRITICAL**

---

## Capture Layer

**HAR does not capture response bodies — requires JS interceptor + replay chain:**
- Issue: Kuri's HAR recording via `harStart`/`harStop` records URLs and headers but not response bodies. The system compensates with three fallback mechanisms: (1) a fetch/XHR JS interceptor injected into the page, (2) Performance API URL discovery + synchronous XHR replay, and (3) HAR-based GET/POST replay via in-page fetch.
- Files: `src/capture/index.ts` lines 776-907
- Impact: This triple-layer capture chain is brittle. Any one layer missing causes silent data loss. POST replay with `credentials: include` can fail on CORS preflights. Sync XHR is deprecated in some browser contexts.
- Fix approach: Upstream fix in Kuri to populate `response.content.text` in HAR entries; until then the replay chain is load-bearing.
- Severity: **High**

**JS interceptor injection race on navigation:**
- Issue: The fetch/XHR interceptor is injected before navigation, but page context resets on load. The re-injection loop polls at 50ms intervals for up to 3 seconds (`src/capture/index.ts` lines 738-749), but SPAs can fire initial API calls within 50-100ms of `DOMContentLoaded` — before the interceptor is re-injected.
- Files: `src/capture/index.ts` lines 731-749
- Impact: Early API calls (first paint hydration fetches on React/Next.js apps) are missed by the interceptor and fall through to the Performance API replay path, which cannot capture POST bodies.
- Fix approach: Use `Page.addScriptToEvaluateOnNewDocument` (exposed as `kuri.scriptInject`) so the interceptor runs before any page JS. The `kuri.scriptInject` API already exists in `src/kuri/client.ts` line 788 but is not used in `captureSession`.
- Severity: **High**

**Headless Chrome detection by Google and other major sites:**
- Issue: A comment in `src/capture/index.ts` line 19 (`BUG-GC-012`) documents that HeadlessChrome is actively blocked. The workaround is spoofing a real Chrome user agent string. Client hint headers (`sec-ch-ua`, `sec-ch-ua-platform`) are also injected to reduce bot detection signals.
- Files: `src/capture/index.ts` lines 19-21, 56-61, 711-713
- Impact: Sites with aggressive bot mitigation (Google, LinkedIn, Cloudflare-protected pages) may still detect and block headless capture despite UA spoofing.
- Fix approach: Full headless evasion requires additional CDP stealth patches (e.g., hiding `navigator.webdriver`). These are not currently applied.
- Severity: **Medium**

**Authenticated SPA capture: cookie injection insufficient for modern SPAs:**
- Issue: Cookie injection sets cookies via CDP `Network.setCookie`. However, many modern SPAs (LinkedIn, Facebook) rely on device trust tokens, fingerprinting signals, and session-bound credentials that cannot be replicated by cookie injection alone. A fresh headless browser session with injected cookies often gets 401/403 responses or redirected login flows even when the vault contains valid cookies.
- Files: `src/capture/index.ts` lines 716-722, `src/execution/index.ts` lines 978-984 and 1682-1693
- Impact: Gated site capture silently degrades — the capture succeeds (no throw) but returns empty or partial API responses.
- Fix approach: The `triggerAndIntercept` approach in `src/capture/index.ts` line 1082 is the correct direction — load the actual app page so SPA auth state initializes, then intercept the triggered API call. This path is not yet the default for all authenticated capture flows.
- Severity: **High**

**`httpOnly` cookies invisible to JS cookie extraction:**
- Issue: Cookie extraction uses `document.cookie` because CDP `getCookies` crashes Kuri. `document.cookie` does not expose `httpOnly` cookies. Many auth session cookies (e.g. `__Secure-*`, `SID`, LinkedIn `li_at`) are `httpOnly`.
- Files: `src/capture/index.ts` lines 638-661
- Impact: Session cookies extracted after capture are incomplete. Downstream skill execution may fail to authenticate replays when relying on extracted cookies.
- Fix approach: Fix the underlying Kuri CDP `getCookies` crash so the native API can be used.
- Severity: **Medium**

**Performance API fallback fails for RSC and streaming transport:**
- Issue: `performance.getEntriesByType('resource')` only lists requests that completed as standard resource loads. React Server Component payloads (`text/x-component`, `_rsc=` param) and HTTP streaming responses are not always represented, or are partial. The RSC parser in `src/capture/rsc.ts` only handles static body strings; streaming wire format chunks are not reassembled.
- Files: `src/capture/index.ts` lines 783-811, `src/capture/rsc.ts`, `src/reverse-engineer/index.ts` line 562
- Impact: Next.js App Router sites and similar RSC-based apps yield lower-quality endpoint discovery.
- Fix approach: Use `PerformanceObserver` for live resource tracking, or intercept RSC streaming payloads via the JS interceptor before stream consumption.
- Severity: **Medium**

---

## Server Lifecycle

**Stale server process after `npm i -g`:**
- Issue: The packaged CLI spawns a detached server process (`src/runtime/local-server.ts` lines 89-142). After a global reinstall, the old server stays running and serves stale code. The version check in `checkServerVersion` (`src/runtime/local-server.ts` line 208) compares pid file version to installed version, but this only works if the pid file version was written correctly on the previous spawn.
- Files: `src/runtime/local-server.ts`
- Impact: "Works from source, broken from package" failures. The #1 operational footgun per CLAUDE.md.
- Fix approach: Always run `pkill -9 -f 'unbrowse|kuri'; sleep 2` after `npm i -g`. Long-term: auto-detect version mismatch on CLI startup and restart the server automatically (partial infrastructure exists in `checkServerVersion`).
- Severity: **High**

**Server process lifecycle not fully supervised:**
- Issue: `LocalSupervisor` (`src/runtime/local-server.ts` line 145) tracks supervisor state but the supervisor start/stop calls are fire-and-forget in several paths (lines 169 and 232). The supervisor does not actually restart a crashed server; it only health-checks.
- Files: `src/runtime/local-server.ts` lines 149-202
- Impact: A server crash after initial startup is not automatically recovered unless the next CLI call triggers `ensureLocalServer`.
- Fix approach: Wire supervisor restart into server crash detection.
- Severity: **Medium**

---

## Version Sync Fragility

**Three version files must be kept in sync and are currently diverged:**
- Issue: Version is stored in three locations: `package.json` (`2.6.0`), `packages/skill/package.json` (`2.0.2`), and `version.json` (`2.0.2`). At time of analysis `package.json` is at `2.6.0` while the other two are at `2.0.2` — they are currently out of sync.
- Files: `package.json`, `packages/skill/package.json`, `version.json`
- Impact: Mismatched versions cause incorrect version reporting in the CLI, incorrect skill package releases, and confusing release artifacts.
- Fix approach: `release-it` is configured to bump all three, but manual edits or partial runs can leave them diverged. Add a pre-commit check that asserts all three versions match.
- Severity: **High**

---

## Kuri Binary Discovery

**Single-binary Kuri discovery chain has 5+ fallback locations:**
- Issue: `getKuriBinaryCandidates()` in `src/kuri/client.ts` lines 117-130 checks: (1) `vendor/kuri/{target}/kuri` relative to package root, (2) `packages/skill/vendor/kuri/{target}/kuri`, (3) `vendor/kuri-src/zig-out/bin/kuri`, (4) `submodules/kuri/zig-out/bin/kuri`, (5) `$HOME/kuri`, (6) `$KURI_PATH`, (7) PATH. The function falls back to `candidates[0]` (not guaranteed to exist) if no candidate exists on disk.
- Files: `src/kuri/client.ts` lines 79-130, 208-213
- Impact: In the packaged distribution, if vendor binaries are absent (wrong platform, CI artifact mismatch), the fallback chain silently picks a non-existent path and fails at spawn time with a confusing error.
- Fix approach: Add an explicit existence check after `findKuriBinary()` and surface a descriptive error pointing to the expected vendor path for the current platform. Run `bash scripts/check-packaged-kuri.sh` after any changes to this area.
- Severity: **Medium**

**`kuri/client.ts` is a fragile wrapper — do not edit casually:**
- Issue: The Kuri client wraps a Zig binary via HTTP. Its `evaluate()` function (lines 412-447) has four duplicate JSDoc comments — an artifact of multiple merge attempts. The CDP response shape (`result.result.result`) is non-standard and has previously silently broken (returning `"[object Object]"`) when Kuri's response format changed.
- Files: `src/kuri/client.ts` lines 412-447, 547-557
- Impact: Any change to this file risks breaking the entire browser automation layer. `getCurrentUrl` and `getPageHtml` call `evaluate()` which can return `"[object Object]"` if CDP response shape changes; callers in `src/capture/index.ts` lines 915-920 guard against this but the validation is fragile.
- Fix approach: CLAUDE.md explicitly forbids editing this file without intent. The duplicate jsdoc on `evaluate` should be cleaned up when intentionally touching the file.
- Severity: **Medium**

---

## Orchestrator Size

**`src/orchestrator/index.ts` is 3,634 lines / 141KB:**
- Issue: The orchestrator is a single file containing: skill routing, live capture orchestration, DAG session logic, cache management (route cache, domain cache, in-flight deduplication), telemetry, auth prerequisite resolution, and structured search form handling.
- Files: `src/orchestrator/index.ts`
- Impact: High cognitive load for changes. Difficult to test individual behaviors in isolation. Long edit-test cycles. Risk of unintended side effects when touching any part of the file.
- Fix approach: Split into focused modules: `src/orchestrator/route-cache.ts`, `src/orchestrator/live-capture.ts`, `src/orchestrator/skill-resolver.ts`. The existing sub-modules (`dag-advisor.ts`, `dag-feedback.ts`, `first-pass-action.ts`, `passive-publish.ts`) show the right pattern.
- Severity: **Medium**

---

## Auth and Cookie Resolution

**`autoExtract` must be `true` in `executeBrowserCapture` cookie resolution:**
- Issue: In `src/execution/index.ts` line 1685, `autoExtract` is conditionally set: `autoExtract: !!skill.auth_profile_ref || endpoint.semantic?.auth_required === true`. If neither flag is set on a skill, browser cookie auto-extraction is skipped silently, and authenticated endpoints return empty results.
- Files: `src/execution/index.ts` lines 1682-1693
- Impact: Skills created without `auth_profile_ref` or `auth_required` semantic flag miss browser cookie extraction even when the target site is gated.
- Fix approach: Default `autoExtract` to `true` for all execution paths, or add a detection heuristic based on domain vault existence.
- Severity: **High**

---

## Security Considerations

**API keys in module-level constants:**
- Risk: `NEBIUS_API_KEY` and `OPENAI_API_KEY` are read from `process.env` at module load time and stored as module-level string constants.
- Files: `src/orchestrator/index.ts` lines 33-34
- Current mitigation: Keys are read from env vars, not hardcoded. No immediate action required.
- Severity: **Low**

---

## Test Coverage Gaps

**No tests for capture retry and cookie injection paths:**
- What's not tested: The `captureSession` ephemeral retry path (`src/capture/index.ts` line 1024), the per-cookie fallback injection path (lines 623-634), and the `triggerAndIntercept` execution path.
- Files: `src/capture/index.ts`
- Risk: Regressions in gated-site capture silently pass CI.
- Priority: High

**No tests for `autoExtract` conditional in `executeEndpoint`:**
- What's not tested: The branch where `autoExtract` is `false` due to missing `auth_profile_ref` / `auth_required` on an endpoint.
- Files: `src/execution/index.ts` lines 1682-1693
- Risk: The silent failure mode (no cookies, empty response) goes undetected.
- Priority: High

**Version sync across three files is not verified in CI:**
- What's not tested: No test or pre-commit hook asserts that `package.json`, `packages/skill/package.json`, and `version.json` share the same version string.
- Files: `package.json`, `packages/skill/package.json`, `version.json`
- Risk: Versions drift silently between releases (currently diverged: `2.6.0` vs `2.0.2`).
- Priority: Medium

---

*Concerns audit: 2026-04-01*
