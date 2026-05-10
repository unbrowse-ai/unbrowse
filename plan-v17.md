# Plan v17: Akamai + Kasada bundle-replay solvers

## Why this

Plan-v13 Tier 2A (Cloudflare) and Tier 2B (PerimeterX) shipped working bundle-replay solvers in `src/execution/cf-challenge.ts` and `src/execution/px-challenge.ts`. The plan-v15 Step 6 deferral named Akamai and Kasada as Tier 6 holdouts. The bench-local corpus has at least 3 BROWSER_BLOCK rows whose vendor classifier hits `akm_bmfp*` (Akamai Bot Manager) or `x-kpsdk*` (Kasada) — those rows have no extraction path today.

Pattern from CF + PX is proven: detect challenge → extract bundle URL → fetch with libcurl-impersonate → wait for cookie gate → retry original request. Same vessel, new wines.

## Pre-conditions (HARD)

- HEAD on `feat/agent-ux-run-planner` (already there at `b660b247`)
- `bash scripts/plan-v17-preflight.sh` 6/6 hard pass before any Tier work
- Read `src/execution/cf-challenge.ts` + `src/execution/px-challenge.ts` first — copy structure, do not invent
- Vendor classifier disambiguation already at `src/execution/index.ts:3578` (`extractBundleSnapshot`) — extend, don't duplicate

## Tier 1 — Akamai Bot Manager solver (~2 days, 1 PR)

### Surface

- `src/execution/akamai-challenge.ts` (NEW): mirror `cf-challenge.ts` shape
  - `extractAkamaiBundleUrl(html)` — regex anchored on `src=["'][^"']*akam[^"']*\.js` OR known Akamai sensor-data endpoint patterns
  - `solveAkamaiAndRetry(opts)` — fetch bundle, wait for `_abck` cookie (Akamai's session token), retry original request with merged cookie jar
  - 1024-byte minimum bundle gate (matches CF/PX)
- `src/execution/index.ts` arm: in vendor_blocked switch at L2945 (after PX arm, before fallthrough at L2946), add `if (failureKind.vendor === "akamai_bot_manager")` arm — note exact string is `akamai_bot_manager`, not `akamai` (per classifier `index.ts:3655`). Use dynamic import pattern (`const { solveAkamaiAndRetry } = await import("./akamai-challenge.js")`) matching CF/PX.
- `src/execution/index.ts` decision-trace: add `vendor_blocked_akamai_solver` / `_retry_success` / `_retry_still_blocked` / `_error` step names (mirror PX exactly)

### Falsifier

- `tests/akamai-bundle-replay-shape.test.sh` (NEW, ~80 LoC): mirror `tests/px-bundle-replay-shape.test.sh` — 5 emitted step names asserted
- `tests/extraction-filter-bypass.test.ts` extension: assert that an Akamai-protected URL with `_abck` cookie set still survives extraction (no false-reject)
- `backend/src/routes/synthetic.ts` extension: add `/v1/test/_synthetic_akamai_challenge` (mirror cf/px shape — 403 with sensor_data body, 200 when `_abck=ok` cookie present; existing routes are not rate-limited, no need to add)

### Risk

- `_abck` cookie format is opaque + may rotate per-tab → solver must be stateless w/r/t cookie expiry; rely on bundle-replay each request rather than caching
- Some Akamai deployments are stacked with Kasada (canadagoose.com per prior session findings) — Tier 1 alone may not unblock those; full coverage needs Tier 2 too
- Akamai bundle URLs sometimes use sub-resource integrity hashes — extractor must tolerate `integrity=` attribute presence

## Tier 2 — Kasada solver (~2 days, 1 PR)

### Surface

- `src/execution/kasada-challenge.ts` (NEW): mirror PX shape
  - `extractKasadaBundleUrl(html)` — regex on `src=["'][^"']*kasada[^"']*\.js` OR `/ips.js` Kasada sensor endpoint
  - `solveKasadaAndRetry(opts)` — POST sensor data to Kasada endpoint, wait for `x-kpsdk-cd` response cookie + `x-kpsdk-cr` request header, retry
  - Self-verify gate: confirm post-solve response lacks `x-kpsdk-block` header
- `src/execution/index.ts` arm: route `vendor:kasada` to `solveKasadaAndRetry`
- Decision-trace step names: `vendor_blocked_kasada_solver_retry_success` / `_retry_still_blocked`

### Falsifier

- `tests/kasada-bundle-replay-shape.test.sh` (NEW, ~80 LoC): 5-step name pin
- `backend/src/routes/synthetic.ts` extension: `/v1/test/_synthetic_kasada_challenge`

### Risk

- Kasada uses dynamic sensor data + JWT-style session tokens. **Step 5 finding (corrected by Step 8 audit)**: `runBundleReplay` IS a QuickJS sandbox with curl-impersonate + fingerprint pool, AND exposes canvas + webgl + `crypto.subtle.digest`. BUT `crypto.subtle.importKey()` and `sign()` are STUBBED at `src/sandbox/bundle-replay-client.ts:323-327` — they reject. Kasada modern sensors call `subtle.importKey + sign` for HMAC token generation. **Tier 2.5 is REQUIRED, not optional**: must implement either (a) full crypto.subtle shim in sandbox (~50-100 LoC), or (b) `kuri.evaluateInPage` JS-runtime path (~200-300 LoC).
- Stacked detection (Akamai+Kasada combo) requires Tier 1 to land first AND vendor classifier to disambiguate correctly (already wired at `index.ts:3735-3742`)

## Tier 3 — Stacked-vendor disambiguation hardening (~0.3 day, in same PR as Tier 2)

### Surface

- **Step 6 finding**: the basic `akm_bmfp` / `x-kpsdk` / `_pxhd` mapping ALREADY EXISTS at `src/execution/index.ts:3735-3742`. Tier 3 originally specified that work; rescope here.
- Real gap: stacked-vendor cases (canadagoose = Akamai+Kasada, also potential Imperva-on-CF) need adversarial test coverage. Add `tests/vendor-classifier-disambiguation.test.ts` (NEW, ~60 LoC) with: Akamai+Kasada stacked HTML, PX+CF stacked HTML, conflicting query-param + cookie signals, garbage params. Assert primary + secondary classification.
## Tier 4 — Shared bundle-challenge utilities [DEFERRED to plan-v18]

**Step 8 audit finding**: original Tier 4 claim of ~50 LoC saved was overstated. Real savings ~14 LoC (after import overhead) and the extraction would touch shipping CF + PX solvers for marginal gain. Per CLAUDE.md "Don't add abstractions beyond what task requires," defer until a 5th solver lands. plan-v17 ships without it; revisit when CF/PX/Akamai/Kasada all have wired implementations + a 5th vendor (Datadome) is in scope.

## Pre-flight script

- `scripts/plan-v17-preflight.sh` (NEW, mirror plan-v16-preflight.sh):
  1. on `feat/agent-ux-run-planner`
  2. `cf-challenge.ts` + `px-challenge.ts` exist with content (≥1KB)
  3. `extractBundleSnapshot` symbol present in `src/execution/index.ts`
  4. `tests/cf-capture-shape.test.sh` and `tests/px-bundle-replay-shape.test.sh` exist (templates to copy)
  5. backend deployable (`bash backend/scripts/build.sh --dry-run` or equivalent)
  6. iproyal proxy secret available locally (soft warn if not)

## What this plan does NOT do

- Captcha solvers (hCaptcha, reCAPTCHA, Turnstile) — separate plan-v18
- Stealth shimming (CDP fingerprint masking, navigator.webdriver hiding) — separate
- DataDome solver — defer; bench coverage shows it less common than Akamai/Kasada
- Marketplace splits — still no source vessel
- GTM / fundraising — orthogonal Lewis-driven track

## Definition of done

- 2 PRs merged (Tier 1 Akamai, Tier 2 Kasada)
- Bench-local rerun shows ≥2 prior-BROWSER_BLOCK rows transition to PASS or PASS_WEAK under the iproyal proxy
- `tests/cf-capture-shape.test.sh` + `tests/px-bundle-replay-shape.test.sh` + new akamai/kasada falsifiers all green
- A1 PR-comment workflow (from plan-v16) catches any regression on subsequent unrelated PR

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Akamai bundle-replay insufficient (needs JS runtime) | medium | fall back to headed Kuri sensor-gen + libcurl token-replay |
| Kasada similarly needs JS sensor | high | same fallback; document headed-capture latency cost |
| Stacked Akamai+Kasada (canadagoose) still blocks after both Tiers | medium | Tier 3 disambiguation routes to whichever is primary; document remaining gap |
| Synthetic fixtures drift from real-world challenge HTML | low | refresh fixtures monthly; pin to current sensor-bundle SHA |
| New Akamai/Kasada sensor-bundle URL pattern breaks regex | medium | regex is generic ("akam"/"kasada"/"ips.js") — extend per real-world capture |

## Cost summary

| Tier | LoC | Tests | Time |
|---|---|---|---|
| T1 Akamai solver + index.ts arm + synthetic fixture | ~150 + 30 yml | ~80 LoC (1 falsifier .sh + 1 .ts ext) | 2 days |
| T2 Kasada solver + index.ts arm + synthetic fixture | ~150 + 30 yml | ~80 LoC | 2 days |
| T3 Classifier disambiguation tightening | ~30 LoC | 60 LoC | 0.5 day |
| Preflight + falsifiers + plan-v17.md itself | ~70 LoC sh + 60 plan | reuse | 0.5 day |
| **Total** | **~430 LoC** | **~220 LoC** | **5 days** |

## Definition of progress (per Jesus Loop step)

- Step 1 Light: read cf-challenge.ts + px-challenge.ts cold; identify the 6-7 functions/regexes/gates that must be mirrored
- Step 2 Firmament: design akamai-challenge.ts module boundaries — what's shared with cf/px (could move to a shared helper) vs. what's vendor-specific
- Step 3 Land: write akamai-challenge.ts skeleton + synthetic fixture skeleton + falsifier shell
- Step 4 Luminaries: 3 falsifiers green (akamai shape pin, kasada shape pin, vendor disambiguation)
- Step 5 Creatures: stacked-vendor adversarial cases, opaque-cookie edge, sensor-bundle URL drift
- Step 6 Dominion: end-to-end on synthetic fixtures + at least one real bench-local row showing transition from BROWSER_BLOCK to PASS
- Step 7 Sabbath: verdict on bench delta
- Step 8 Judgement: 13-agent audit on regex correctness, race in sensor token reuse, vendor classifier mis-routing
- Step 9 Emergence: commit, push, CHANGELOG line
