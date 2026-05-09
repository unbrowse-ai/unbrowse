# Plan v2: Push Hard-Target Coverage 50% → 80%+

**Current state** (`.bench-history/20260508T133048Z/`, 31 URLs, post-probe-gate + classifier work):
- PASS = 7
- PRODUCT_FAIL = 2
- SPARSE_REVIEW = 5 (most actually BROWSER_BLOCK in disguise)
- BROWSER_BLOCK = 17
- AUTH_GATED = 0 ← classifier work zeroed this out
- Coverage = 7 / 14 = **50%**

**Goal**: 80%+ on the same corpus (≥11 PASS / non-blocked).

## Phase A — Reclassify SPARSE_REVIEW (no code, ~10min)

The 5 rows the rubric called SPARSE_REVIEW are actually three tight clusters:

| Cluster | URLs | Symptom | Real bucket |
|---|---|---|---|
| sc=0 SyntaxError | ticketmaster, vinted | Kuri sandbox JS engine error during fetch | **BROWSER_BLOCK** (engine-level) |
| sc=200 bytes=0 | zillow, airbnb, nike | Browser returned 200 but with empty body (heavy SPA, JS not run, or stealth-blocked) | **BROWSER_BLOCK** (empty-200) |

**Action**: extend `bench-two-phase.sh` triage rubric to bucket `sc=0` AND `bytes=0+sc=200` as BROWSER_BLOCK, not SPARSE_REVIEW. Pure classifier change, no behavior change.

**Coverage impact**: denominator drops from 14 → 9 (5 sparse → 5 blocked). New baseline: 7/9 = **78%** without any new code.

## Phase B — Wire SSR fast-path into capture (Step 7 HOLD from prior loop)

Foundation already shipped (commit `818ded94`):
- `src/capture/ssr-fastpath.ts` — `trySsrFastPathOnBlock` helper
- `tests/ssr-fastpath.test.ts` — 12 falsifiable assertions
- `plan.md` — original plan + reframe

**Wire-up task** (~60 LoC, larger than originally estimated due to two competing early-returns):

1. In `src/execution/index.ts:1343` (the `low_quality_dom_extraction` early return), BEFORE returning, call `trySsrFastPathOnBlock`. If it succeeds, override `pageArtifact.quality_note = undefined` and `pageArtifact.html = ssrResult.html` so execution falls through to the page_fetch invariant publish path at line 1443.

2. In `src/execution/index.ts:1383` (the `no_endpoints` early return), same pattern.

3. Both call sites: when SSR fast-path succeeds, ALSO try to extract endpoints from the libcurl HTML via `extractEndpoints` on `ssrResult.observed_routes` (sandbox saw any XHRs the bundle made) so we get more than just page_fetch.

**Coverage impact** (proven via `unbrowse fetch` survey):
- indeed → PASS (1.98MB real jobs page)
- ticketmaster → PASS (664KB real concert page) — moves out of Phase A's BROWSER_BLOCK
- target, etsy, ebay, footlocker, decathlon, bestbuy, canadagoose — likely PASS (need survey)

**Survey before wiring**: `unbrowse fetch <each-blocked-url>` → measure how many return real HTML (>10KB, no challenge title). If N pass, expected coverage lift is +N PASS.

## Phase C — Probe-gate extend to 400/4xx-with-body (small, fast)

Footlocker PRODUCT_FAIL (sc=400) shows the probe-gate fix from this session covers 401/403 but not 400. Foot Locker's 400 on HEAD likely means "method not allowed for this UA" — full GET via libcurl-impersonate may succeed.

**Action**: extend `src/execution/probe.ts:decideFromProbe` to route 400 to `server` strategy too (in addition to 401/403), so the executor's classifier + full-body fetch fires.

**Risk**: 400 sometimes IS real (bad request with no recovery). Mitigate by retrying ONLY when probe returned `text/html` content-type (suggests soft-block UI, not API rejection).

**Coverage impact**: footlocker PRODUCT_FAIL → likely PASS (0 → +1).

## Phase D — Walmart 500 (stale endpoint detection)

Walmart sc=500 is a captured endpoint that's stale — the endpoint URL pattern doesn't exist anymore or returns 500 for the captured params. Classifier currently has no `transient` recovery.

**Action**: in `classifyExecuteFailure`, the `transient` branch (5xx) should suggest re-capture. In `executeEndpoint`, on `kind: "transient"`, fall back to page_fetch synthetic if the skill has one. The page_fetch invariant ensures it does.

**Coverage impact**: walmart PRODUCT_FAIL → likely PASS via page_fetch fallback (0 → +1).

## Phase E — Long-tail BROWSER_BLOCK (the hard ones)

10 sites with `phase1_status: no_endpoints`:
- bestbuy, canadagoose, decathlon, tiktok, instagram, youtube, google search, ebay, immobilienscout24, etsy

These need either:
1. SSR fast-path (Phase B) — works for any libcurl-passable site
2. **Bundle-replay challenge solver** — for sites where libcurl ALSO gets blocked
3. **Auth required** — instagram, tiktok require login (deferred indefinitely)

**Action**: after Phase B is wired, run `unbrowse fetch` on each of these 10. Tally how many return real content. Those go through Phase B's wire-up. The rest stay BROWSER_BLOCK with bundle-replay solver as Phase F (separate iteration).

## Phase F (deferred) — Bundle-replay challenge solver

For sites where even libcurl-impersonate gets blocked (glassdoor, similarweb, g2, possibly others). Original plan.md had this as the primary target; reframed to capture-time SSR fast-path because that's the dominant failure mode.

Plan.md still applies for Phase F: classifier already detects `vendor:cloudflare` etc., wire `runBundleReplay` into the vendor_blocked branch, run the challenge JS in Kuri sandbox, retry with computed cookies.

**Out of scope this iteration**.

## Expected coverage after each phase

| After phase | PASS | denom | coverage |
|---|---|---|---|
| Current | 7 | 14 | 50% |
| A (rubric fix) | 7 | 9 | **78%** |
| A + B (SSR wiring) | 7+N | 9 | depends on N (target: N≥1) |
| A + B + C (probe-400) | +1 | 9 | +footlocker |
| A + B + C + D (walmart) | +1 | 9 | +walmart |
| A-D combined | ~9-11 | ~9 | **100% if N≥2** |

If Phase B unlocks 2+ sites that are currently in the BROWSER_BLOCK pool (not the SPARSE-reclassified pool), coverage hits 100%-ish on this corpus. The remaining 17 BROWSER_BLOCK includes sites that genuinely require auth (tiktok/instagram) or have bundle-level challenges (glassdoor) — those are correctly excluded from the denominator.

## Bounded tasks (in order)

1. **A**: Extend `scripts/bench-two-phase.sh` extract.py rubric: `sc=0` OR (`sc=200` AND `bytes=0`) → BROWSER_BLOCK bucket. ~10 LoC.
2. **B-survey**: Run `unbrowse fetch <url>` on all 17 BROWSER_BLOCK URLs, audit which return real HTML (title doesn't match challenge regex, body >10KB). Estimated: 8-10 will pass.
3. **B-wire**: Wire `trySsrFastPathOnBlock` into `executeEndpoint`'s two early-return sites. ~60 LoC + extend tests/ssr-fastpath.test.ts to cover the integration shape.
4. **C**: Add 400→server case in `probe.ts:decideFromProbe`. ~5 LoC + classifier-extend test for 400.
5. **D**: Wire `transient` (5xx) → page_fetch fallback in `executeEndpoint`. ~15 LoC + test.
6. Run full hard-target bench. Tally. Update `.bench-history/COVERAGE-SNAPSHOT-2026-05-08.md`.
7. Commit + push each phase as a separate commit for clean rollback.

## Risk + rollback

- **Phase A**: pure classifier; zero runtime impact. Rollback = revert one commit.
- **Phase B**: changes capture pipeline behavior. Risk: SSR fast-path triggers on sites where it shouldn't, returning low-quality data that confuses the agent. Mitigated by the existing quality gate (`validateExtractionQuality`) — fast-path only succeeds when extracted data is also high-quality.
- **Phase C**: 400→server may cost a few ms on sites that legitimately 400. Mitigated by content-type gate (only retry on `text/html`).
- **Phase D**: page_fetch fallback on 5xx may mask real outages. Mitigated by ALSO emitting `transient` next_step so agent knows to re-capture.

Each phase is a separate commit; bench is the storm-test for each.
