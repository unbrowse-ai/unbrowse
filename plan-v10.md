# Plan v10: Master plan for the last 11 BLOCKs

## Current state (post-v6.7.0-preview.12, run `20260509T030602Z`)

Released package, 28-URL active corpus. 16 PASS / 16 = 100% on non-blocked. The 11 BLOCK rows fall into FIVE distinct categories, each needs a different lever:

| Category | Count | Sites | Lever |
|---|---|---|---|
| **A. CF Bot Management** | 4 | indeed, glassdoor, realtor, similarweb | Residential proxy + Kuri stealth upgrade |
| **B. Auth-required pre-empt** | 3 | canadagoose, decathlon, target | Reroute SSR before auth_required return |
| **C. DataDome** | 1 | leboncoin (alternates) | Residential proxy (Phase A primitive) |
| **D. Soft block / partial extraction** | 2 | g2, similarweb (alternates) | SPA-state extractors (Apollo/Pinia/Zustand) |
| **E. Captcha / Akamai / PerimeterX / Kasada** | 0-3 | (none currently in corpus) | Per-vendor solvers — deferred indefinitely |

All five depend on shared infrastructure already in the repo: `runBundleReplay`, `trySsrFastPathOnBlock`, `executeBrowserCapture`. Each phase = 1 commit, gated by a smoke test.

**Realistic budget:** A + B + D = ~6 hours for the biggest unlock window. C is bundled into A (same proxy infra).

**Sequence:** A → B → D → (E only on customer pull). C wraps into A's smoke results.

---

## Phase A: Wire IProyal residential proxy into `runBundleReplay`

**Premise**: CF, DataDome, PerimeterX all score IP reputation. Datacenter IPs (Kuri sandbox runs on the user's machine — datacenter-class IP for cloud users) trigger automatic challenges. Residential IPs from IProyal pass IP-reputation gate; combined with Kuri's existing Chrome 131 JA4 fingerprint, this is the biggest single lever.

### Surface

1. `src/sandbox/bundle-replay-client.ts:SandboxReplayRequest` — add optional `proxy: string` field
2. `src/sandbox/bundle-replay-client.ts:runBundleReplay` — pass `proxy` through to Kuri sandbox
3. `src/capture/ssr-fastpath.ts:trySsrFastPathOnBlock` — accept and forward `proxy` to `runBundleReplay`
4. `src/execution/index.ts:1265-1283` — pass `proxy` into the Phase A SSR insertion call
5. `src/execution/index.ts:vendor_blocked branch (~L2719)` — pass `proxy` into bundle-replay retry IF we wire that (Phase A.bundle from plan-v9, currently blocked)
6. New env var `UNBROWSE_PROXY_URL` (or auto-pull from memory `reference_iproyal_proxy.md`)

### Patch shape

```ts
// SandboxReplayRequest
export interface SandboxReplayRequest {
  // ... existing fields ...
  proxy?: string; // e.g. "http://user:pass@geo.iproyal.com:12321?country=us"
}

// runBundleReplay request body
const body = JSON.stringify({
  // ... existing fields ...
  ...(req.proxy ? { proxy: req.proxy } : {}),
});

// trySsrFastPathOnBlock — accept proxy from caller
export interface SsrFastPathInput {
  // ...
  proxy?: string;
}

// executeBrowserCapture — pass proxy through
const ssr = await trySsrFastPathOnBlock({
  url, seedCookies: captured.cookies,
  proxy: process.env.UNBROWSE_PROXY_URL,
  timeoutMs: 15_000,
});
```

### Kuri-side requirement

Kuri's `/v1/sandbox/replay` endpoint must accept a `proxy` field and route libcurl-impersonate through it. **Verify before commit**: `grep -r "proxy" submodules/kuri/` to confirm Kuri supports proxy passthrough. If not, this plan halts — Kuri PR comes first.

### Smoke test (mandatory before commit)

```bash
# Set proxy env (creds from memory reference_iproyal_proxy.md)
export UNBROWSE_PROXY_URL="http://USER:PASS@geo.iproyal.com:12321"

# Run Phase B from plan-v9 again — same eval, same target
unbrowse fetch "https://www.glassdoor.com/Reviews/index.htm" --raw --no-browser-cookies
```

### Three outcomes

1. **200 + real glassdoor HTML** → ship Phase A wire-up; CF unlocked via proxy.
2. **403 + CF challenge page** → IP rotation didn't help; CF is also fingerprint-checking. Phase A still ships (other sites benefit), but CF stays blocked. Re-evaluate stealth upgrade.
3. **Sandbox error / timeout** → IProyal not reachable from Kuri. Debug network path before commit.

### Predicted unlock

If outcome 1: indeed, glassdoor, realtor, similarweb (CF-fronted) + leboncoin (DataDome) = **+5 sites**.
If outcome 2: 0 (defer to Phase D Kuri-stealth-upgrade).

### Tests

`tests/sandbox-proxy-passthrough.test.ts` (NEW, 3 assertions):
1. `runBundleReplay({proxy: "http://..."})` → request body contains `proxy` field
2. `trySsrFastPathOnBlock({proxy: ...})` → forwards to `runBundleReplay`
3. `executeBrowserCapture` → reads `UNBROWSE_PROXY_URL` env, passes through

### Cost

~30 LoC + ~30 LoC tests + 1 commit + 30 min smoke. ~90 min IF Kuri supports proxy. +2-4 hr if Kuri PR needed.

---

## Phase B: Reroute SSR before auth_required pre-empt

**Premise**: canadagoose, decathlon, target return `auth_required` from `executeBrowserCapture` BEFORE Phase A's SSR gate fires. These sites aren't truly auth-gated — they serve an auth wall to non-browsers (anti-bot pattern). Fix: try SSR fast-path BEFORE early-returning auth_required, OR distinguish vendor-induced auth_required from real auth.

### Surface

`src/execution/index.ts:1040-1052` — the `error: "auth_required"` early return.

### Two patch options

**Option B.1 — Always try SSR before auth_required return**:
```ts
// Before existing auth_required return at L1040
if (looksAuthRequired) {
  // Try SSR first — anti-bot often presents auth wall to non-browsers
  const ssr = await trySsrFastPathOnBlock({
    url, seedCookies: captured.cookies,
    proxy: process.env.UNBROWSE_PROXY_URL,
    timeoutMs: 15_000,
  });
  if (ssr?.html && ssr.html.length > 1024) {
    const ssrArtifact = buildPageArtifactCapture(url, intent, ssr.html, false);
    if (ssrArtifact.endpoint && ssrArtifact.result) {
      // Success: site is anti-bot-only, libcurl gets the real page
      // Synthesize page_fetch endpoint and publish as if capture succeeded
      // ... (re-use the synthesis path from L1280-1340) ...
      return { /* success */ };
    }
  }
  // Fall through to existing auth_required return
}
```

**Option B.2 — Detect anti-bot vs real auth heuristically**:
```ts
// Look at captured.requests for vendor signals
const hasVendorChallenge = captured.requests.some(r =>
  /(captcha-delivery|cdn-cgi\/challenge-platform|datadome|perimeterx)/i.test(r.url ?? "")
);
if (looksAuthRequired && !hasVendorChallenge) {
  // Real auth — return auth_required as today
} else {
  // Vendor-induced — try SSR fast-path first
}
```

**Recommendation**: B.1 is simpler, B.2 is more honest. Ship B.1 with B.2 as a follow-up if false-positives appear (real auth-gated sites would burn libcurl latency before returning auth_required).

### Tests

`tests/auth-required-ssr-reroute.test.ts` (NEW, 4 assertions):
1. Mock auth_required path + SSR success → returns page_fetch synthetic, NOT auth_required
2. Mock auth_required path + SSR null (libcurl also blocked) → returns auth_required as today
3. Mock auth_required path + SSR returns CF challenge HTML → quality gate rejects, returns auth_required
4. Real auth-gated site (mocked) + SSR returns 401 page → quality gate rejects, returns auth_required

### Predicted unlock

canadagoose, decathlon, target — **+3 sites** (assuming Phase A's residential proxy succeeds; otherwise libcurl might also fail on Kasada).

### Cost

~40 LoC + ~50 LoC tests + 1 commit. ~90 min.

### Risk

Real auth-gated sites (e.g. linkedin if added to corpus) would now spend 15s on a libcurl attempt before returning auth_required. Acceptable; capture pipeline has 90s timeout anyway.

---

## Phase C: SPA-state DOM extractors (Apollo / Pinia / Zustand / __INITIAL_STATE__)

**Premise**: g2 and similarweb return partial HTML — Kuri's tab loaded the page but `extractFromDOM` couldn't find structured data. These are SPAs whose initial state isn't in `__NEXT_DATA__` (already supported) but in less common stores: Apollo Client cache, Pinia state, Zustand stores, plain `window.__INITIAL_STATE__`.

### Surface

`src/extract/dom.ts` (or wherever `extractFromDOM` lives) — add new extraction methods.

### Patterns to add

```ts
// Apollo Client cache
const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/);

// Pinia (Vue 3)
const piniaMatch = html.match(/__pinia\s*=\s*(\{[\s\S]*?\});/);

// Generic window.__INITIAL_STATE__ (older React/Redux SSR)
const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);

// Vuex state
const vuexMatch = html.match(/window\.__INITIAL_VUEX_STATE__\s*=\s*(\{[\s\S]*?\});/);
```

Each match → JSON.parse the captured group → run through existing schema-extract / quality-validate path.

### Tests

`tests/spa-state-extractors.test.ts` (NEW, 8+ assertions):
- Synthetic HTML with each store pattern → confirm extraction returns valid data
- Adversarial: malformed JSON, nested templates with similar shape, etc.

### Predicted unlock

g2, similarweb → **+2 sites** (if their HTML carries any of these stores).
Survey before commit: `unbrowse fetch g2.com --raw --no-browser-cookies | grep __APOLLO_STATE__` — if 0 matches across 5 attempts, this phase is no-op.

### Cost

~80 LoC + ~80 LoC tests + 1 commit. ~3 hr.

---

## Phase D: Kuri stealth upgrade (deferred behind Phase A's smoke result)

**Only run if Phase A smoke = outcome 2** (residential proxy alone doesn't unlock CF). At that point the bottleneck is fingerprint detection, and the fix is in Kuri's sandbox runtime.

### Surface (Kuri-side, separate repo)

`submodules/kuri/` — JS context shimming:
- `navigator.webdriver = false` (often set by Chromium automation)
- Audio context fingerprint (sine wave generation noise)
- Canvas fingerprint (pixel-level noise injection)
- WebGL fingerprint (GPU vendor/renderer override)
- Plugin/MIME-type list (real Chrome has 5-10 plugins; headless has 0)

### Tests

Inside `submodules/kuri/`. Out of scope for the unbrowse repo.

### Predicted unlock

Hard to predict — depends on whether CF is fingerprint-detecting OR IP-detecting OR both. After Phase A's outcome 2 we'll know which.

### Cost

Half-day Kuri PR + Kuri release + smoke retest. Half-day to a full day.

### Defer trigger

Only if Phase A smoke = outcome 2.

---

## Phase E: Paid bypass service fallback (parked indefinitely)

**Only if A/B/C/D all run AND there's a customer asking for specific CF/Akamai/Kasada sites by name.**

### Vendors

- **FlareSolverr** (free, self-hosted) — wraps puppeteer with stealth, exposes HTTP API. Pull bypass from local instance.
- **ScrapingBee** ($) — turnkey, charges per request.
- **Browserless** ($) — self-hosted-able stealth Chrome.

### Why parked

Per CLAUDE.md "no per-domain heuristics + no third-party hard-deps" principle. Adding a paid bypass to the bundle inflates trust surface and adds runtime cost per request. Only justified by a paying customer.

### Trigger

A customer email naming the site, asking for the integration, willing to pay.

---

## What's NOT in this plan

- **Captcha-gated** (hCaptcha, reCAPTCHA): never solvable without paid solver. Stays BLOCK with `e_captcha_required` bucket if added.
- **Geo-restricted with hard country-lock**: would need country-rotating proxy fleet. Not in scope.
- **Sites that require browser interaction** (form fill, click-through): out of capture-pipeline's reach. Already handled by `unbrowse go` interactive flow.

---

## Order

| Phase | Cost | Pre-req | Predicted unlock | Kills BLOCK |
|---|---|---|---|---|
| A (residential proxy) | 90min + smoke | Kuri proxy support + IProyal creds | indeed, glassdoor, realtor, similarweb, leboncoin (5) | -5 |
| B (auth_required reroute) | 90min | A landed (uses same proxy) | canadagoose, decathlon, target (3) | -3 |
| D (Kuri stealth upgrade) | half-day | A outcome 2 | uncertain | maybe -2 |
| C (SPA-state extractors) | 3hr | survey first | g2, similarweb (2) | -2 |
| E (paid service) | per-customer | customer pull | various | various |

**Recommended sequence**: A → B → C-survey → D (only if A fails on CF) → E (never, until customer).

---

## Definition of done (full plan-v10)

- 3-4 commits on `feat/agent-ux-run-planner`, each independently revertable
- Smoke outcomes documented for each phase (A, D required; C optional)
- Hard-target bench shows ≥6 net BLOCK→PASS transitions (A=5, B=3, C=2 = up to 10, realistic 5-7)
- Coverage on 28-URL active corpus: 16/16 (100%) → 23/26 (~88%) post-A+B if both succeed
- Zero per-domain heuristics introduced (CLAUDE.md ban honored)
- Plan-v10 updated post each phase with measured outcomes vs predictions

---

## Cost ceiling

| Phase | Cost | Cumulative |
|---|---|---|
| A (proxy) | 1.5 hr | 1.5 hr |
| B (auth reroute) | 1.5 hr | 3 hr |
| C (SPA extractors) | 3 hr | 6 hr |
| D (Kuri stealth) | 4-8 hr | 10-14 hr |
| E (paid service) | ~2 hr each | per-customer |

**Realistic budget**: A + B + C = ~6 hr for the biggest leverage window without Kuri PR.

---

## What to do if a phase fails its prediction

- **A unlocks 0 sites (proxy ineffective)**: jump to D smoke — fingerprint is the bottleneck, not IP. If D also fails, mark CF-class as honestly-blocked and ship E only on customer pull.
- **B unlocks 0 sites (auth_required is real for these specific sites)**: revert; some of these MIGHT be real auth-required (canadagoose for personalization?) and the heuristic is wrong.
- **C survey returns 0 sites with Apollo/Pinia/initial-state markers**: skip C. The SPAs use something else (custom store, no SSR state).
- **D blocks on Kuri PR review time**: park the loop, file Kuri ticket, re-trigger when fixed.

Never extend a phase's scope to rescue a failed prediction. New scope = new plan.

---

## What changes for the bench

After A + B + C run cleanly:
- 28 active URLs
- ~22-25 PASS (currently 16-18)
- ~3-6 honest BLOCKs (mostly captcha-class or hard CF)
- Coverage on non-blocked subset stays ~100%, denominator grows

---

## Re-trigger conditions

- **Phase A revives**: after Kuri proxy support lands (ASAP)
- **Phase B revives**: after Phase A confirmed working (proxy makes libcurl more likely to bypass auth-walls)
- **Phase C revives**: after a survey of 5 BLOCK sites confirms the SPA-state markers exist
- **Phase D revives**: only if Phase A fails to unlock CF
- **Phase E revives**: customer-pull only

---

## Cost of NOT doing this

10 BLOCK rows on the canonical bench. Each is honestly classified, but every "X doesn't work on Unbrowse" complaint that lands in inbound is potentially in this list. A's residential-proxy is the highest-ROI lever — if even one CF or DataDome site unlocks, that's a public-facing win for the bench narrative.
