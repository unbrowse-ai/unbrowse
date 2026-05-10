# Plan v8: Resolve Remaining BLOCK Sites

## Current state (post-plan-v7, run `20260508T231214Z`)

Coverage 17/17 = 100% on non-blocked subset. The 14 honestly-blocked rows fall into 3 distinct categories, each needing a different fix:

| Category | Count | Sites | Fix |
|---|---|---|---|
| **A. Capture didn't yield endpoints** | 4 (+2 corpus-noise) | etsy, ebay, immobilienscout24, canadagoose, glassdoor*, leboncoin* | Phase B-wire (capture-time SSR fast-path) |
| **B. Vendor bot-management** | 5 | indeed, realtor (CF), leboncoin (datadome), 2 others | Bundle-replay challenge solver |
| **C. Auth-gated** | 3 | tiktok, instagram, youtube | Out of scope — replace in corpus |

*glassdoor and leboncoin oscillate between Phase 1 capture-fail and Phase 2 vendor-block depending on freshness.

Order of impact (highest leverage first): **A → C → B**.

---

## Phase A: Wire capture-time SSR fast-path (~60 LoC, ~90 min)

**Helper already shipped** at `src/capture/ssr-fastpath.ts:trySsrFastPathOnBlock` (commit `818ded94`, 12 unit tests green). Phase D wired it into the **execute-side 5xx fallback** (commit `ef0cf046`). The capture-side wiring is the missing piece.

### Surface (2 call sites in `src/execution/index.ts`)

**Site 1**: `low_quality_dom_extraction` early return (~L1343):
- Pre-condition: browser capture got HTML but DOM extractor rejected quality (e.g. CF "Just a moment..." page)
- Patch: before returning, call `trySsrFastPathOnBlock`. On success, override `pageArtifact.html` and clear `quality_note`. Fall through to publish path.

**Site 2**: `no_endpoints` early return (~L1383):
- Pre-condition: capture got 0 endpoints (anti-bot intercepted XHRs, or libcurl-only sites that don't make XHRs)
- Patch: same pattern. On success, run `extractEndpoints` over `ssrResult.observed_routes` (sandbox bundle-replay's interceptor catches XHRs the page would have made).

### Tests

`tests/ssr-fastpath.test.ts` extension (2 integration assertions):
- `quality_note → fastpath success → trace.success && skill published`
- `no_endpoints → fastpath success → page_fetch synthetic emitted`

### Predicted unlock

Survey from `.bench-history/PHASE-B-SURVEY-2026-05-08.md` (still relevant): 6/18 BLOCK sites pass when `unbrowse fetch` (libcurl) runs against them. Concrete candidates from current corpus:
- canadagoose (no_endpoints)
- etsy (no_endpoints)
- ebay (no_endpoints)
- immobilienscout24 (no_endpoints)

Coverage delta: 17/17 → 21/21 (+4 PASS, denom unchanged because they're already in BLOCK pool).

### Risk

- libcurl-fetched HTML extraction could falsely succeed on a CF challenge page that doesn't say "Just a moment". Mitigated by existing `validateExtractionQuality` gate AFTER the helper returns — only publishes if extraction quality is high.
- Cost: ~60 LoC + ~30 LoC tests + 1 commit.

---

## Phase C: Corpus hygiene — replace auth-gated sites (~5 min)

`scripts/corpus/hard-target-bench.txt` includes tiktok, instagram, youtube. These can't pass without login — they're permanent BLOCK noise that pollutes the histogram.

**Action**: replace them with 3 public-data sites that exercise the same anti-bot tier:
- TikTok → swap for hashnode.com/n/ai (tag pages, no auth)
- Instagram → swap for unsplash.com/s/photos/ai (search, no auth)
- YouTube → already covered by google search; swap for archive.org/details/ai (no auth)

OR mark them with a `# auth-gated; bench excludes` comment and tighten the bench rubric to skip them entirely (a new bucket like `e_auth_gated_excluded` that's not even in the histogram).

**Cost**: ~5 LoC corpus change + maybe 1 rubric line.

### Risk

- Replacing erases the "we honestly mark auth-gated as BLOCK" datapoint. Mitigated by the explicit comment.
- Lewis's call: corpus surface area is product-evangelism territory, not just engineering.

---

## Phase B: Bundle-replay challenge solver (~150 LoC, deferred)

The original `plan.md` target. Wires `runBundleReplay` (already shipped in `src/sandbox/bundle-replay-client.ts`) into `executeEndpoint`'s vendor_blocked branch. When CF/datadome blocks, replay the challenge JS in Kuri sandbox, get computed cookies (`cf_clearance`, `_dd_p`, etc.), retry serverFetch with those cookies.

### Why it's deferred

1. **Higher uncertainty**: depends on whether Kuri sandbox actually solves CF's fingerprint checks (decision point A in plan.md). Survey not yet run.
2. **Higher LoC**: ~80 LoC executor wiring + ~30 LoC tests + ~30 LoC `extractBundleSnapshot` extensions for vendor-specific bundle URLs.
3. **Per-vendor expansion**: CF first, then datadome, then PerimeterX. Each vendor is a new integration surface.

### When to reach for Phase B

After Phase A unlocks the 4 easy ones, the remaining BLOCK pool is purely vendor-hardened sites. That's the right moment — narrow target, clear signal, no easier wins to take first.

### Predicted unlock

Best case: 3-4 sites (indeed, realtor, leboncoin, glassdoor). Worst case: 1-2 if Kuri can't pass CF fingerprint. Bench survey before commit.

---

## Order

| Phase | LoC | Tests | Time | Coverage delta |
|---|---|---|---|---|
| A (capture SSR wire) | 60 | 2 | 90 min | +4 PASS (canadagoose, etsy, ebay, immobilienscout24) |
| C (corpus hygiene) | 5 | 0 | 5 min | denom -3 (cleaner signal) |
| B (bundle-replay) | 150 | 4 | half-day | +3-4 PASS (CF/datadome sites) |
| **Total** | **215 LoC** | **6** | **~6 hr** | corpus → ~25/27 = 92%+ |

**Recommended sequence**: A first (highest leverage, infrastructure already exists). C second (cleans the histogram). B last (real moat, but bigger risk).

---

## What this plan does NOT do

- Doesn't add per-domain heuristics (CLAUDE.md ban).
- Doesn't touch Kuri internals.
- Doesn't try to "fix" sites that genuinely require login.
- Doesn't redesign the bench rubric — extends bucketing only where useful.

---

## Definition of done (Phase A only — the immediate next step)

- 1 commit on `feat/agent-ux-run-planner`
- 2 new ssr-fastpath integration tests green
- Hard-target bench shows ≥2 of {canadagoose, etsy, ebay, immobilienscout24} flipped from `y_capture_didnt_yield_endpoint` to `a_inspect_response_body`
- No regression on existing PASS rows
- Coverage on hard-target corpus: 17/17 → ≥19/21

---

## Cost

Phase A alone: ~60 LoC + 2 tests + 1 commit + 1 bench rerun. ~90 min. Same shape as plan-v6 / plan-v7 — single bounded patch, narrow surface, easy revert.
