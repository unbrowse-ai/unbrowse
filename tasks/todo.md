# E2E Header Capture & Replay Test

## Goal
Build a real E2E test that validates the full unbrowse pipeline:
Playwright capture → HAR parse → header profile → skill generation → API replay.

Test against real sites with actual internal API endpoints (not web pages).

## Plan

### Phase 1: Plan
- [x] Understand full capture → replay data flow
- [x] Identify testable sites with public internal APIs
- [x] Design test structure

### Phase 2: Implement
- [x] Create `test/evals/capture-replay-eval.ts`
- [x] Use Playwright to browse real sites and capture XHR/fetch traffic
- [x] Run captured HAR through `parseHar()` → verify `headerProfile` is populated
- [x] Call `buildHeaderProfiles()` on captured entries → verify profiles have correct headers
- [x] Replay captured API endpoints 4 ways:
  - Bare fetch (no headers) → baseline
  - With `resolveHeaders(profile, ..., "node")` → app-only headers
  - With `resolveHeaders(profile, ..., "browser")` → full profile (simulating browser path)
  - Exact replay → original captured headers (minus protocol/browser)
- [x] Compare responses: status codes, body lengths, blocked/not-blocked
- [x] Log which headers the profile captured (verify site-specific headers detected)
- [x] Delete old wrong eval (`header-replay-eval.ts`)

### Phase 3: Test targets
1. **Reddit** — SPA with shreddit internal APIs (GraphQL, partials, svc endpoints)
2. **Carousell SG** — `/ds/` and `/api/` internal endpoints with Cloudflare
3. **GitHub** — `/trending` page (mostly POST endpoints, limited GET APIs)

## Results (2026-02-09)

### Reddit (www.reddit.com)
- **Captured**: 101 HAR entries, 16 API endpoints (shreddit partials, policy, events)
- **Profile**: 4 domains detected, 2-6 headers per domain (accept, priority, user-agent, referer)
- **Replay**: bare=1/5, node=1/5, full=1/5, exact=2/5
- **Insight**: Most shreddit endpoints are session-gated. Exact replay helps for `/partial/` endpoint (cookies in original headers). `/policy` (204) passes regardless.

### Carousell (www.carousell.sg)
- **Captured**: 788 HAR entries, 32 API endpoints (`/ds/`, `/api/`, analytics)
- **Profile**: 12 domains detected, content-type, priority, origin headers captured
- **Replay**: bare=5/5, node=5/5, full=1/5, exact=1/5
- **Insight**: **Node mode validated** — Carousell APIs pass perfectly without context headers. Sending browser UA from Node.js triggers Cloudflare TLS mismatch → 4/5 blocked in browser mode.

### GitHub (github.com)
- **Captured**: 152 HAR entries, 1 API endpoint (POST `/_private/browser/stats`)
- **Profile**: 3 domains (avatars.githubusercontent.com, api.github.com, collector.github.com)
- **Replay**: Skipped (only POST endpoints, no safe GET APIs to replay)

## Key Findings

1. **"node" mode is correct for Node.js fetch** — Carousell proves it: 5/5 pass with node mode, 1/5 with browser mode
2. **Browser UA from Node.js actively hurts** — Cloudflare detects Chrome UA + Node TLS fingerprint = bot
3. **Exact header replay helps for session-gated endpoints** — Reddit's partials work with original headers (include cookies)
4. **`recordHar` hangs, event interception works** — Switched to `context.on("response")` for reliable capture
5. **The profiler correctly captures site-specific headers** — `priority`, `content-type`, `origin` all detected by frequency

## Architecture

```
capture-replay-eval.ts:
  1. playwright.chromium.launch() → context.on("response") → collect HarEntry[]
  2. Track API endpoints separately via isApiCall() filter per site
  3. parseHar({ log: { entries } }, seedUrl) → apiData.headerProfile
  4. For each captured GET API endpoint:
     a. doFetch(url, {}) → bare
     b. doFetch(url, resolveHeaders(profile, "node")) → node mode
     c. doFetch(url, resolveHeaders(profile, "browser")) → browser mode
     d. doFetch(url, cleanOriginalHeaders) → exact replay
  5. Compare: which strategy unblocks?
```

## Files
- `packages/plugin/test/evals/capture-replay-eval.ts` — the E2E eval
- `packages/plugin/test/evals/header-replay-eval.ts` — deleted (old wrong test)
