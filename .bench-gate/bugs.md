# Unbrowse bugs ledger — session 2026-05-18 → 2026-05-19

Curated from the MCP gate convergence loop, including bugs SHIPPED (with
PR number) and bugs SURFACED but unresolved. Each entry: evidence,
diagnosis, and either the fix or the proposed fix.

The taxonomy is by root cause, not by symptom. A symptom often appears
in multiple lanes; the root cause appears once.

---

## Part 1 — Shipped this session

### B-001 · Collector reason classification poisoned by close.next_step prose
- **Status:** Fixed in PR #496 (commit f7dcc519).
- **Symptom:** 17/58 probes in run 20260518T092341Z returned `reason="go_failed"` even though `/v1/browse/go` succeeded; the classifier was matching prose strings from `close.next_step`.
- **Fix:** Split `classifyReason()` into 3 disjoint buckets: `indexed` / `go_failed` / `capture_did_not_emit_skill_id`, gated by `close.body` shape rather than text.
- **Surface:** `scripts/mcp-gate-parallel-classify.ts`.

### B-002 · resolve.trace.skill_id carried cross-skill on no_match
- **Status:** Fixed in PR #496 (commit 34bc9eb5).
- **Symptom:** Bench collector occasionally attributed an endpoint to a skill that didn't own it, because `resolve.trace.skill_id` was read even when `status === "no_match"`.
- **Fix:** Gate skill_id fallback by status. Only trust the field when resolve actually picked a skill.
- **Surface:** collector `pickSkillId` in `scripts/mcp-gate-parallel-classify.ts`.

### B-003 · capture_diagnostic opaque on indexed=false
- **Status:** Fixed in PR #496 (commit ba6bc29d).
- **Symptom:** 17 probes returned `indexed=false` with no signal what failed (rejected by ranker? no endpoints? captured noise only?).
- **Fix:** Surface `capture_diagnostic` field with `no_endpoints_extracted` /
  `all_endpoints_filtered_by_noise_rules` / `endpoints_scored_below_relevance_threshold`.
- **Surface:** `src/api/browse-index.ts`.

### B-004 · concat-validator false positives recovered captures as junk
- **Status:** Fixed in PR #497.
- **Symptom:** Valid multi-fetch captures were being dropped because the
  validator's overlap detection fired on legitimate boundary repetition.
- **Fix:** Tighten threshold + add positive-evidence anti-rule.

### B-005 · /v1/browse/go failures invisible to judge
- **Status:** Fixed in PR #497.
- **Symptom:** When `go` failed, only `index.store.json.reason="go_failed"` surfaced;
  the actual kuri error (port-in-use, spawn-timeout, tab-not-found) was dropped.
- **Fix:** Collector stores `go.body` in `close.body._go_failed`; capture.meta exposes `go_failed` field.

### B-006 · Concurrent /v1/browse/go races createBrowseSession
- **Status:** Fixed earlier (commit 41fab174, pre-session).
- **Symptom:** At conc≥4, concurrent go-calls assigned the same broker tab to multiple sessions; probe A rendered probe B's page.
- **Fix:** Per-broker create-lock + create-on-unknown-id.

### B-007 · --headless=new background-throttles non-active tabs
- **Status:** Fixed earlier (commit db9190af, kuri re-vendor).
- **Symptom:** Concurrent snap at N≥4 starved 3/4 tabs (empty a11y tree); Chrome's renderer was backgrounding non-active targets.
- **Fix:** Added Playwright-standard background-throttle suppression flags to kuri's Chrome launcher.

### B-008 · kuri attachToExistingChrome default ON hijacked user's real browser
- **Status:** Fixed in PR #498.
- **Symptom:** Bench-gate runs (and any unbrowse capture) silently attached to
  the user's visible Chrome whenever it was running, bypassing HEADLESS=true and
  leaking captures into the user's profile.
- **Fix:** Flip default to OFF. Opt-in via `KURI_ATTACH_EXISTING_CHROME=1` or
  persisted `browser.attach_existing_chrome=true`. `KURI_CLEAN_ROOM=1` /
  `UNBROWSE_LOCAL_ONLY=1` / `KURI_DISABLE_CDP_ATTACH=1` still trump opt-in.

### B-009 · Concurrent kuri broker spawn race
- **Status:** Fixed in PR #499.
- **Symptom:** Multiple `startOn()` calls in parallel re-entered the spawn
  routine before health-check returned; same broker port got bound twice.
- **Fix:** Module-scope `KURI_SPAWN_CONCURRENCY` semaphore around `startOn`.

### B-010 · Heuristic admission gate rejected real captures
- **Status:** Fixed in PR #500 (substrate-correct removal).
- **Symptom:** `shouldIndexDomBrowseFallback` rejected captures with extraction
  confidence < 0.5, blocking legitimate DOM extractions and forcing fallbacks.
  The gate baked a verdict into admission instead of letting usage decide quality.
- **Fix:** Removed the gate entirely. Every non-null capture admits with neutral
  `reliability_score: 0.5`. Darwinian feedback via `unbrowse_reflect` +
  `dag-feedback` boost (0.05/success) lets the ranker demote junk and promote
  reliable endpoints organically.

### B-011 · augmentEndpointsWithAgent was dead code
- **Status:** Fixed in PR #501.
- **Symptom:** The LLM-augmentation function existed at `src/graph/agent-augment.ts`
  but had ZERO callers. Every skill was published with heuristic descriptions
  only; the BM25 ranking ate stub descriptions.
- **Fix:** Wired into both HTTP-path and DOM-path publish sites in
  `src/api/browse-index.ts`. Reads `OPENAI_API_KEY` or `NEBIUS_API_KEY`,
  uses `UNBROWSE_AGENT_SEMANTIC_MODEL=moonshotai/Kimi-K2.5` by default.

### B-012 · Shortlist endpoints carried no skill provenance
- **Status:** Fixed in PR #502.
- **Symptom:** Resolve's `available_endpoints` shortlist could include
  endpoints from cached publishes whose skill_id differed from the top-level
  pick. Collector used top-level skill_id → `endpoint_not_found` on execute.
- **Evidence:** Probe 003 (crates.io) — top-level skill `V-ugzSxDfgDKHR0TD_ufE`
  had 1 endpoint; shortlist[0] `3bqbHNiOc3pUKKy3ezdAG` belonged to a sibling.
- **Fix:** Stamp `source_skill_id` on every shortlist entry at all 3 build sites
  in `src/orchestrator/index.ts`. Collector prefers `pick.source_skill_id` over
  top-level `skillId`.

### B-013 · 404-recovery carried just-evicted endpoint_id
- **Status:** Fixed in PR #503.
- **Symptom:** When execute returned 404, `executeEndpoint` evicted the
  endpoint from local cache. The recovery branch then called
  `resolveAndExecute({...execParams, url: recoveryUrl})` — `execParams` still
  carried the dead endpoint_id, so the second execute hit `endpoint_not_found`
  even though sibling endpoints existed.
- **Fix:** Destructure `endpoint_id` off `execParams` before passing to recovery
  in `src/api/routes.ts`. Recovery's contract is "this endpoint is stale; let
  resolve pick a fresh one."

### B-014 · Admission-gate mutation tests pinned removed behaviour
- **Status:** Fixed in PR #504.
- **Symptom:** `tests/browse-index-dom-fallback-cookies.test.ts` had 2 tests
  asserting `indexed === false` for CF-stub admissions; those failed after PR
  #500 removed the gate. The tests were pinning the heuristic.
- **Fix:** Delete the obsolete mutation tests. Happy-path + non-fatal-error
  tests cover every invariant the file legitimately owns post-#500.

### B-015 · Local cache evicted on first 404 (single-strike)
- **Status:** Fixed in PR #505.
- **Symptom:** Every HTTP 404 from an execute call evicted the endpoint
  immediately. Backend's auto-deprecation policy is 2 strikes; local mirror
  was 1, killing callable sibling endpoints during transient failures
  (404-recovery in-flight, deploy lag, cache race, params off-by-one).
- **Fix:** Add `src/client/eviction-strikes.ts`. HTTP 404 increments a strike
  in a 5-minute window; eviction only fires on the 2nd strike. HTTP 410 still
  evicts immediately (protocol-level "gone for good" is unambiguous).
  Successful execute clears strikes via `clearEndpointStrikes`.

### B-016 · 404-recovery waited 2.5s for marketplace round-trip
- **Status:** Fixed in PR #506.
- **Symptom:** Recovery already held the failed skill in hand. Calling
  `resolveAndExecute` ran the orchestrator's marketplace race with the
  default 2500ms timeout (`UNBROWSE_RESOLVE_SEARCH_TIMEOUT_MS`), adding pure
  latency tax to every stale-404 retry.
- **Fix:** Add `ExecutionOptions.local_skills_only` boolean. Recovery sets it
  to `true`; orchestrator's marketplace branch short-circuits when the flag
  is set.

### B-017 · Hostile-lane PASS auto-flagged as suspicious
- **Status:** Fixed in PR #507.
- **Symptom:** GATE_JUDGE.md said "if hostile lane returns real data, emit
  `suspicious: true`". That worked when bypass was rare. Substrate now
  reliably evades anti-bot on Ticketmaster/Nike/Target/ESPN; flagging every
  clean PASS as suspicious capped hostile coverage at 0 (the rubric ceiling).
- **Fix:** Clarify rubric. Clean hostile PASS with concrete quotable data is
  just PASS. `suspicious: true` fires only on 4 enumerated trip-wires:
  partial data + challenge artefacts, masked critical fields, wrong-entity
  slip, truncation past first record.

### B-018 · description_source='agent' inferred from prose shape
- **Status:** Fixed in PR #508.
- **Symptom:** `classifyDescriptionInput()` returned "agent" for any prose
  that wasn't generic-shaped. Pre-#501 skills (where the LLM augmenter never
  ran) still got stamped `description_source: "agent"`, misleading calling
  agents about what metadata had actually been LLM-reviewed.
- **Fix:**
  1. `classifyDescriptionInput` narrowed to `"auto" | "missing"` only.
  2. `augmentEndpointsWithAgent` stamps `semantic.description_source = "agent"`
     authoritatively when the augmenter runs.
  3. `getEndpointDescriptionMetadata` + `computeSemanticDescriptor` gate the
     "agent" label SOLELY on the authoritative marker.

### B-019 · MCP wedged by stale global :6969 daemon
- **Status:** Fixed in PR #509 (warn-and-remediate, not auto-kill).
- **Symptom:** Phase 0d removed the HTTP daemon, but users with older
  globally-installed `unbrowse` binaries still auto-spawn a :6969 daemon.
  When both run, kuri state leaks across them and the browse transport
  wedges permanently — user must `/mcp reconnect` to recover.
- **Fix:** Probe localhost:6969 at MCP startup. If anything answers, surface
  a loud actionable warning on stderr with the exact `pkill -9 -f
  'unbrowse|kuri'` remediation. Configurable via `UNBROWSE_DAEMON_PROBE_URL`
  / `UNBROWSE_DAEMON_PROBE_TIMEOUT_MS`. Opt-out via
  `UNBROWSE_SKIP_DAEMON_PROBE=1` for users running `unbrowse serve`
  intentionally. Does NOT auto-kill (substrate doesn't decide for the user).

### B-020 · Anti-bot retry auto-flipped to visible Chrome (poisoned other probes)
- **Status:** Fixed in PR #510.
- **Symptom:** `forceVisibleKuriEnv()` mutated process-global env on every
  anti-bot wall detection. One probe's flip poisoned every concurrent
  session's headless setting. Users saw Chrome windows pop up during
  bench-gate runs, MCP tool calls, scripted CLIs.
- **Fix:** `forceVisibleKuriEnv` is a no-op by default. Two opt-in paths:
  caller passes `{ allow: true }` (interactiveLogin does this); or env
  `UNBROWSE_ALLOW_VISIBLE_AUTH_FALLBACK=1`. Legacy
  `UNBROWSE_FORCE_HEADLESS=1` still trumps both.

### B-021 · Bench had no probes exercising cookie-injected auth
- **Status:** Fixed in PR #511 (lane added; substrate bug surfaced in B-022 below).
- **Symptom:** Existing auth-gated lane only tested handoff; every probe
  was EXCLUDED from coverage. Authenticated retrieval via cookie
  auto-injection was completely uncovered. No way to know if the
  substrate's Dia/Chrome cookie extraction actually reached protected
  content.
- **Fix:** Add `auth-cookies` lane (8 probes: Linear, GitHub settings,
  Notion, YouTube subs, Reddit logged-in, X home, Gmail, Cursor). Collector
  surfaces `browser_cookies: { cookies_available, session_cookies, browser }`
  in capture.meta.json. GATE_JUDGE.md teaches two-regime rubric (logged-in
  vs not + failure-mode for cookies-present-but-login-wall).

### B-022 · Collector intendedHost declaration eaten by patch
- **Status:** Fixed in PR #512.
- **Symptom:** PR #511's browser-cookie patch accidentally replaced the line
  defining `const intendedHost = hostOf(p.url)`. Collector failed to start
  with "Unexpected }" on first launch.
- **Fix:** Restore the variable + delete leftover dangling line.

---

## Part 2 — Surfaced by the 66-probe gate run, NOT yet fixed

Critical context: with all 17 PRs merged, index coverage is **53.8%** and
retrieve coverage is **42.3%** (thresholds: 80% / 65%). The bugs below
are what's left on the table.

### B-023 · Cookie injection bypassed at capture phase (auth-cookies lane shows 0/6)
- **Severity:** CRITICAL. Single biggest substrate gap.
- **Evidence:** Of 8 auth-cookies probes, 6 had Dia cookies present
  (`browser_cookies.session_cookies` ranged from 4 to 138). Every single one
  failed:
  - 045 GitHub settings (17 session): resolve hard-handoff, no fetch attempt
  - 046 Notion (6 session): drift on stale cross-host skill
  - 047 YouTube subs (138 session): captured page was Google Sign-in redirect
  - 048 Reddit logged-in (4 session): picked /r/programming/ then 403
  - 049 X home (16 session): stale_endpoint 401
  - 050 Gmail (130 session): cross-host poisoned skill returned X.com-shaped drift
- **Diagnosis:** The substrate extracts Dia cookies (proven by the
  `browser_cookies` evidence the collector surfaces) but they're not being
  injected into the live capture-phase fetches. Resolve then falls through
  to whatever cached marketplace skill matches the host — often stale,
  cross-host-poisoned, or wrong-entity.
- **Proposed fix:** Trace the capture path's auth-loading. `cacheBrowseRequests`
  takes `getCookies` but it's optional; check whether bench-gate's collector
  (or the MCP/CLI flow) actually wires it through. If yes, check whether
  the cookies are being attached to the kuri tab via `setCookie` BEFORE the
  live navigation. The smoking gun in 047 (YouTube redirected to Sign-in
  with 138 cookies in hand) says cookies arrived too late or not at all.
- **Falsifier:** A test that calls `cacheBrowseRequests` on a CF-cookie-gated
  test server with `getCookies` providing the right cookies and asserts the
  capture rendered the gated content.

**A3 — Root cause diagnosed 2026-05-19 (jesus-loop Step 3 Land, diagnostic primitive `scripts/cookie-injection-probe.ts`).**

The probe traced the 5 layers between Dia SQLite and the kuri tab jar for `https://www.youtube.com/feed/subscriptions` and emitted:

```
extract=155  (Dia=141, Chrome=14)
pick=141     (browser=Dia, domain_key=www.youtube.com, session_cookies=138)
inject=141   (importBrowserCookiesIntoTab returned 141)
jar=0        (broker.getCookies(tabId) returned 0 cookies for the host)
wall=true    (captured page is the login wall)
```

The drop is between **inject → jar** and it is total. Stderr from every `setCookie` call:

```
no CDP websocket for tab <tabId>; falling back to /cookies for secure cookie ...
```

**Three coupled defects make this catastrophic:**

1. `resolveCdpDebuggerUrlForTab` in `src/kuri/client.ts` returns null for freshly-spawned tabs (the new `about:blank` tab from `kuri.newTab` isn't yet visible in the CDP `/json` listings on ports 9222-9225 at the moment `setCookie` runs). CDP path short-circuits.
2. The legacy `/cookies` GET fallback in `setCookie` does NOT persist secure/httpOnly cookies to the tab's jar — at least on the kuri broker version running on this box. Every fallback call is a silent no-op.
3. `importBrowserCookiesIntoTab` in `src/auth/index.ts:75-76` does `await kuri.setCookie(...)` then `imported += 1` UNCONDITIONALLY — the CDP success/fail boolean is discarded. So `imported` reports **API calls that resolved without throwing**, NOT cookies that landed. The counter is a false truth signal.

**Disjunction final state.** Plan R3 narrowed from {a, b, c, d}:
- (a) collector-skip on pre-resolve cache hit — **CONFIRMED** as the cause for 5/6 probes (045/046/048/049/050), independent of (1)(2)(3) above.
- (b) `isLikelyAuthenticatedCookie` filter — **RULED OUT** (Step 1).
- (c) CDP wipe — **RULED OUT in shape, but a new failure mode emerged in same layer**: not "wipe after navigation" but "never set at all because CDP target unresolved → silent fallback to no-op endpoint." For probe 047 and any direct go-path probe where cookies SHOULD apply.
- (d) something else — **CONFIRMED THREE-LAYERED**: CDP target unresolved + lossy fallback + dishonest counter.

**Fix surfaces (revised for Step 4):**

- **F1 (kuri target visibility):** Wait for the new tab to appear in `/json` before claiming setCookie. Live in `src/kuri/client.ts` `resolveCdpDebuggerUrlForTab` — add a retry-with-backoff (e.g. 3 attempts, 100/200/400 ms) before returning null. Bounded delay (≤700ms one-time) on tab creation.
- **F2 (honest counter):** `importBrowserCookiesIntoTab` post-loop calls `kuri.getCookies(tabId)` and returns the count of cookies actually present, not the count of calls. Hardens against any future regression in `setCookie`. Live in `src/auth/index.ts:63-100`.
- **F3 (no silent fallback for secure cookies):** When CDP target is unresolved and the cookie is `secure || httpOnly`, return false (or throw) instead of silently falling back to the legacy endpoint. The auth layer already handles the `false`/throw via its log + skip. Live in `src/kuri/client.ts` setCookie.
- **F4 (collector force-go for auth-cookies lane):** `UNBROWSE_GATE_FORCE_GO=1` env that bypasses the pre-resolve cache-hit short-circuit at `scripts/mcp-gate-parallel-collect.ts:55-72`. Lets the gate actually exercise the cookie injection path for ALL auth-cookies probes, not just the 1/6 that happened to miss the cache. Substrate untouched.
- **F5 (collector evidence wire):** Surface `cookies_injected` from go.body into `capture.meta.json` so future runs have the inject count without rerunning the diagnostic primitive. Tiny mod to `scripts/mcp-gate-parallel-collect.ts`.

Step 4 lands F4 + F5 (collector — no substrate touch, low risk, immediate fleet-wide signal). Step 5 lands F1 + F2 + F3 (substrate — surgical, gated by the falsifier test which un-skips once these ship).

Note: B-024 (cross-host stale skill cache pollution) remains separate but its observation is sharpened — when F4 forces go for auth-cookies probes, the pre-resolve cache misses won't matter, but the underlying cache-pollution still affects non-gate consumers in production. Tracked in a follow-up loop.

### B-024 · Stale cached skills bleed cross-host
- **Severity:** HIGH.
- **Evidence:** Probe 050 (gmail.google.com) returned a `schema_drift_recapture_required`
  error whose `removed_fields` included `entities.tweets` and `entities.users` —
  classic X.com Twitter shape. The resolve had picked a stale X.com-cached
  endpoint for a Gmail intent.
- **Diagnosis:** Resolve's marketplace lookup matches by intent + domain, but
  when the local cache holds a stale-but-still-loaded skill from a different
  host, the ranker can pick it. Cross-host pollution of the local skill
  cache.
- **Proposed fix:** Strict host filter at resolve: if `skill.domain !==
  context.url's host`, drop unless explicitly cross-host by design (rare).
  The B-015 2-strike eviction will eventually evict these, but only on
  repeated failures.

### B-025 · Resolve picks wrong entity for same-domain different-path
- **Severity:** HIGH.
- **Evidence:** Probe 048 (reddit logged-in front page `https://www.reddit.com/`)
  resolved to `https://www.reddit.com/r/programming/` — a wrong path on the
  right domain. Same-domain entity discrimination failure.
- **Diagnosis:** A8 entity substitution works at execute-time
  (`src/execution/index.ts`) but the ranker doesn't seem to penalise
  endpoints whose path is entity-shaped-but-different from the context URL.
- **Proposed fix:** In `rankEndpoints`, demote endpoints whose `trigger_url`
  has more or fewer path segments than the contextUrl when those extra
  segments are entity-shaped (subreddit names, usernames, IDs). The
  openlibrary probes (018/019 OL45804W vs OL27448W) show A8 disambiguation
  works on path-template ID parameters but fails on different-but-real
  paths like `/` vs `/r/programming/`.

### B-026 · Schema-drift error envelope eats data too eagerly
- **Severity:** MEDIUM-HIGH. Affects 5 probes.
- **Evidence:** 010 dockerhub, 031 priceline, 046 notion, 047 youtube, 057
  southwest all returned `schema_drift_recapture_required` instead of useful
  content. The substrate refuses to surface drifted data even when partial
  data might satisfy the agent's intent.
- **Diagnosis:** `detectSchemaDrift` is binary — any breaking-removed field
  triggers the error envelope. The agent never sees what DID come back.
- **Proposed fix:** Make drift response soft: surface the drifted data AND
  the drift summary, let the calling LLM judge whether the partial response
  satisfies the intent. Or: gate drift-rejection on `severity=critical` only,
  warn on `severity=minor`.

### B-027 · Cloudflare classifier flips PASS → EXCLUDED at retrieval (not at capture)
- **Severity:** LOW (cosmetic but misleading).
- **Evidence:** Probes 016 (SO), 061 (stockx), 062 (baseball-ref) appeared
  as INDEX_PASS at capture time (snap rendered a 200 page with non-trivial
  HTML), but execute-time replay was 403'd and classified as cloudflare.
  The judge then correctly marks them RETRIEVE_EXCLUDED_BLOCKED, but the
  index counters showed wins that retrieval threw away.
- **Diagnosis:** Cloudflare serves the real page once (capture succeeds) and
  blocks the libcurl replay (execute fails). The capture-phase
  `browser_block_signals` doesn't pick up CF when the first render succeeds.
- **Proposed fix:** Either propagate execute-time vendor classification back
  to the indexed skill's metadata so subsequent resolves know to skip it,
  OR mark these as INDEX_EXCLUDED_BLOCKED retroactively when retrieval
  confirms the vendor.

### B-028 · Ranker promotes telemetry/config endpoints over real APIs
- **Severity:** MEDIUM.
- **Evidence:** 
  - 002 npm/openai: picked maintainer-avatar list endpoint over package metadata
  - 009 pypi/anthropic: picked release-history table over project info
  - 042 slack channel: picked Canvas controller-resources (module loader URLs) over messages
  - 057 southwest: picked marketing nav tiles over flight schedule
  - 059 target: picked breadcrumb JSON-LD over product listings
  - 066 vinted: picked catalog category tree over item listings
- **Diagnosis:** BM25 over endpoint description matches on substring (e.g.
  "openai" appears in maintainer avatar URLs) without checking whether the
  response *shape* matches the intent's content expectation. The page-artifact
  promotion in `rankEndpoints` (LIST_INTENT path) helps for some cases but
  not when the captured page has multiple list-shaped sections (real data
  vs metadata).
- **Proposed fix:** When multiple list-shaped DOM extractions exist on the
  same page, prefer the one whose `example_fields` contain intent-relevant
  type keywords (e.g. "price"+"product" for product search; "title"+"author"
  for posts; "time"+"team" for sports scoreboard) over the one with
  generic nav/footer/breadcrumb shapes.

### B-029 · stackoverflow / reddit empty_snapshot dropped capture silently
- **Severity:** MEDIUM.
- **Evidence:** 012, 013, 017 (and others) had
  `browser_block_signals: ["empty_snapshot"]` and `dom_html_size: 0` with
  reason `no_html`. Kuri's snap returned nothing; capture indexed nothing.
- **Diagnosis:** Either the page bot-detected and refused to render, or
  kuri's snap timing missed the SPA hydration window.
- **Proposed fix:** Wait-for-content heuristic in snap (wait until
  `document.body.children.length > 0` AND
  `document.querySelectorAll('[role=main],main,article').length > 0`).
  Currently relies on a fixed timeout.

### B-030 · resolve fails before capture even attempts a fresh skill
- **Severity:** MEDIUM. Affects 044, 045, 046, 048, 049, 050.
- **Evidence:** All 6 cookie-present-but-failed auth-cookies probes had
  `index.store.json.stored: false` with reason
  `capture_did_not_emit_skill_id`. Capture didn't produce a skill, and
  resolve fell back to cached/stale routes.
- **Diagnosis:** Tied to B-023 — if cookie injection IS the issue, capture
  is being silently failed by auth redirects, but the substrate doesn't
  retry capture with the (extracted but un-used) cookies.
- **Proposed fix:** When capture emits no skill AND
  `browser_cookies.session_cookies > 0`, retry capture with `getCookies`
  populated from `findBestBrowserSession`. Currently the cookies are
  surfaced for the judge but not consumed by the substrate's auto-retry.

### B-031 · Geo-redirects masquerade as 200 successes
- **Severity:** LOW-MEDIUM.
- **Evidence:**
  - 060 bestbuy redirected to country-selector page (HTTP 200, page is a wall)
  - 065 glassdoor redirected `glassdoor.com` → `glassdoor.sg` (iso_self_check
    showed host_match=false)
- **Diagnosis:** Anti-bot systems serve a content-wall as 200. iso_self_check
  surfaces the host mismatch for glassdoor but not for bestbuy (same host,
  different path).
- **Proposed fix:** When capture title or H1 contains "Select your country" /
  "Choose a region" / etc., classify as `browser_block_signals: ["geo_redirect"]`
  and exclude from coverage.

### B-032 · Google Maps tile-data classified as intent_mismatch
- **Severity:** LOW.
- **Evidence:** 064 google maps recipe-replay returned opaque tile coordinate
  arrays; substrate's intent_mismatch check correctly rejected it. The capture
  itself produced nothing (B-029 pattern).
- **Diagnosis:** Recipe replay learned the wrong-shape endpoint as a baseline,
  and capture can't re-learn because Maps' SPA doesn't expose its real data
  endpoints in a way the current extractor finds.
- **Proposed fix:** Out of scope for the current substrate. Maps requires
  special-case handling (their internal API is heavily obfuscated).

---

## Part 3 — Architectural / pattern-level

### A-001 · Substrate has cookies but doesn't use them at capture-phase
- The single highest-impact missing connection. B-023 + B-030 are the same
  bug at two layers. Cookie extraction works (proven), cookie injection at
  capture doesn't (proven). The auth-cookies lane was designed exactly to
  surface this and now we have 6 mutually-corroborating data points.

### A-002 · Drift detection too binary, too eager
- B-026 affects multiple lanes. Schema drift should be a SIGNAL the agent
  judges, not a VERDICT the substrate emits. The pattern matches the
  removed admission gate (B-010): bake a verdict into the wrong layer.

### A-003 · Ranker scores tokens, not response shape
- B-028 is at least 6 visible failures. The ranker chooses on description
  BM25 but doesn't check whether the response will *contain* what the
  intent asked for. The dom_extraction confidence + example_fields are
  available; they're not being weighted by intent-content match.

### A-004 · Local cache pollution from cross-host stale skills
- B-024 cost us probe 050. The same mechanism may explain other
  auth-cookies misses (substrate picks stale skill instead of capturing
  fresh).

---

## Coverage delta this session

| Metric | Start | After 17 PRs | Threshold |
|---|---|---|---|
| Index coverage | 26% (baseline) | 53.8% | 80% |
| Retrieve coverage | 22% | 42.3% | 65% |
| Anchor PASS | 1/11 | 10/11 (index) · 8/11 (retrieve) | 11/11 |
| Hostile clean bypass | 0 (all suspicious) | 4 (none suspicious) | n/a |
| Auth-cookies lane | n/a (didn't exist) | 0/6 PASS (lane reveals B-023) | n/a |

Closing the gap from 42% → 65% retrieve needs B-023 (cookie injection)
+ B-025 (entity discrimination) + B-028 (ranker shape-awareness) at
minimum. Anchor must-pass blockers are B-028 manifestations.
