# Plan v12: Fix the remaining 4 PRODUCT_FAIL rows

## Diagnosis (evidence from `.bench-history/20260509T030602Z/`)

The released-package bench (v6.7.0-preview.12) hits 16/20 = 80%. The 4
rows in the denom that fail are NOT all the same shape — they split into
two distinct root causes:

| URL | Bucket | Real cause | Evidence |
|---|---|---|---|
| g2.com/categories/crm | `z_likely_soft_block` | **Cloudflare + DataDome challenge** | rejected_samples include `cdn-cgi/challenge-platform/h/g/scripts/jsd/...` AND `geo.captcha-delivery.com/captcha/?...` |
| similarweb.com/website/openai.com | `y_capture_didnt_yield_endpoint` | **CloudFront edge geo/IP-rep block** | title="error: the request could not be satisfied" + `challenge_title` signal |
| leboncoin.fr/recherche?text=velo | `z_likely_soft_block` | **DataDome challenge** | rejected_samples include 3× `geo.captcha-delivery.com/...` |
| bestbuy.com/site/searchpage.jsp | `y_capture_didnt_yield_endpoint` | **Pipeline timeout (60s)** | error="cli_timeout", ms=60001, no captured meta at all |

**3 of 4 are mis-classification, not real product failures.** The vendor
fingerprint detector only fires on response-body markers (`_abck`,
`akm_bmfp`, `kpsdk`, the regex hardened in plan-v10 Phase B). It does
NOT inspect the URLs in `rejected_samples` for known vendor hosts. So
when a site challenges via JS-loaded captcha (no body cookies, just
script URLs), the row falls to `sparse_capture_mostly_noise` only — and
the rubric classifies that as PRODUCT_FAIL instead of BROWSER_BLOCK.

If we fix the classifier, 3 rows flip from `z_likely_soft_block` /
`y_capture_didnt_yield_endpoint` (denom-counted, fail) to
`z_likely_vendor_blocked` (excluded). Coverage moves 16/20 → 16/17 =
**94%** WITHOUT changing any product code, just by reading evidence
that's already in `rejected_samples`.

The 4th (bestbuy) is a real product issue — capture pipeline hangs at
the 60s `cli_timeout` and emits zero metadata. Different fix.

## Phase A: URL-fingerprint vendor signals (~30 LoC, ~30 min)

Wire the existing `rejected_samples` URLs through a vendor-host pattern
matcher and emit synthetic `vendor:*` block signals. Lives in the same
file as the body-marker regex from plan-v10 Phase B.

### Surface

`src/capture/browser-block-detection.ts` (or wherever
`browser_block_signals` is computed — find via search; existing entry
points include `assessIntentResult` callsite):

```ts
const VENDOR_URL_HOST_PATTERNS: Array<{ host: RegExp; signal: string }> = [
  // DataDome
  { host: /\bcaptcha-delivery\.com\b/i, signal: "vendor:datadome" },
  // Cloudflare challenge platform (Turnstile / managed challenge)
  { host: /\bcdn-cgi\/challenge-platform\b/i, signal: "vendor:cloudflare" },
  // Akamai bot manager
  { host: /\bakam\.net\b|\bakamaihd\.net\/.*\/(akam|sensor)\b/i, signal: "vendor:akamai_bot_manager" },
  // PerimeterX
  { host: /\b(perimeterx|px-cdn|px-cloud|px-client)\b/i, signal: "vendor:perimeterx" },
  // Imperva / Incapsula
  { host: /\bincapsula\.com\b|\bimperva\.com\/_Incapsula_Resource\b/i, signal: "vendor:imperva_incapsula" },
  // Kasada
  { host: /\bkasada\.io\b/i, signal: "vendor:kasada" },
  // Shape Security / F5 BIG-IP
  { host: /\bshapesecurity\.com\b|\bf5\.com\/.*shape\b/i, signal: "vendor:shape_security" },
];

export function deriveVendorSignalsFromUrls(rejected_samples: { url: string }[]): string[] {
  const found = new Set<string>();
  for (const { url } of rejected_samples ?? []) {
    for (const { host, signal } of VENDOR_URL_HOST_PATTERNS) {
      if (host.test(url)) found.add(signal);
    }
  }
  return [...found];
}
```

Then merge those signals into `browser_block_signals` at the same point
the body-marker signals are computed. Set inclusion handles dedup if
both body and URL detect the same vendor.

### Tests

`tests/vendor-url-signals.test.ts` (new, ~80 LoC):

1. DataDome URL only → emits `vendor:datadome`
2. Cloudflare challenge URL only → emits `vendor:cloudflare`
3. Akamai sensor URL → emits `vendor:akamai_bot_manager`
4. Mixed (CF + DataDome from g2 case) → emits BOTH signals
5. Empty rejected_samples → emits zero signals
6. Adversarial: `not-cdn-cgi.example.com/challenge-platform` does NOT
   false-match (boundary regex)
7. Real-world fixture: parse the actual leboncoin captured_meta JSON
   from this bench run and assert `vendor:datadome` emitted

### Bench rubric coupling

The bench `extract.py` (or wherever `triage_bucket` is computed) already
treats any `browser_block_signals` containing `vendor:*` as
`z_likely_vendor_blocked` — that's the existing rule. Adding
URL-derived `vendor:*` signals to that array makes the bucket flip
automatically.

### Predicted delta

- g2.com → `z_likely_soft_block` → `z_likely_vendor_blocked` (excluded)
- leboncoin.fr → `z_likely_soft_block` → `z_likely_vendor_blocked`
  (excluded)
- similarweb.com → `challenge_title` already triggers exclusion in some
  rubric paths but currently lands in `y_capture_didnt_yield_endpoint`;
  CloudFront uses Akamai for some checks but the title-only signal is
  weak. With this patch, similarweb's title="error: the request could
  not be satisfied" combined with sparse-capture stays
  `y_capture_didnt_yield_endpoint` UNLESS we also add a CloudFront edge
  detector. Net: needs Phase A.5 (small extension).

### Phase A.5: CloudFront edge / IP-reputation block (~10 LoC)

The similarweb title is a CloudFront stock error page. Add to the
title-fingerprint detector (which already handles `Just a moment...` for
CF):

```ts
const CHALLENGE_TITLE_PATTERNS: RegExp[] = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /the request could not be satisfied/i,  // NEW — CloudFront edge block
  /pardon our interruption/i,             // (PerimeterX in some configs)
  /verifying you are human/i,
];
```

That title alone, when paired with `text_bytes < 1000` and zero real API
calls, justifies emitting `vendor:cloudfront_edge_block`. Then
similarweb flips to `z_likely_vendor_blocked`.

## Phase B: BestBuy timeout — capture pipeline hangs at 60s (~40 LoC, ~60 min)

Different problem. The capture pipeline hits the 60s `cli_timeout` with
zero captured_meta. Bestbuy uses Akamai bot manager + a JS-heavy SPA
that requires sustained interaction to fire its real product API.

### Diagnosis options

1. **Headless detection by Akamai → page hangs in render loop**: Kuri's
   stealth extension might be insufficient. Test by running with
   `HEADLESS=false` locally and seeing if the page renders.
2. **SPA needs scroll / interaction**: products load on viewport scroll.
   Static HTML capture sees 0 product XHRs because none have fired.
3. **Pipeline genuinely deadlocked**: capture worker waits for an event
   that never arrives.

### Surface

`src/capture/index.ts` capture timeout handler (find via search for
`cli_timeout` emission):

When timeout fires AND `captured_meta.observed_api_calls === 0` AND
`html_bytes === 0`, treat it as a capture failure that the SSR fast-path
might rescue. The SSR fast-path in `trySsrFastPathOnBlock` is already
plumbed (3 call sites, plan-v10 Phase A). We need a 4th call site:

```ts
// New 4th site: capture timeout fallback
if (
  capturedMeta.observed_api_calls === 0 &&
  capturedMeta.html_bytes === 0 &&
  errorCode === "cli_timeout"
) {
  const ssrResult = await trySsrFastPathOnBlock({
    url: targetUrl,
    proxy: process.env.UNBROWSE_PROXY_URL,
    kuriBase: kuriClient.baseUrl,
    timeoutMs: 15_000,
  });
  if (ssrResult.success && ssrResult.html) {
    // re-run extractEndpoints on the SSR HTML
    // (bestbuy SSRs the search results into __NEXT_DATA__-equivalent)
  }
}
```

### Tests

`tests/capture-timeout-ssr-fallback.test.ts`:

1. Synthetic timeout result with zero metadata → SSR fast-path is called
2. SSR returns valid HTML with embedded JSON → extracts page-artifact
3. SSR also fails → emits honest `capture_diagnostic: "no_html_after_timeout_and_ssr"`

### Predicted unlock

- bestbuy.com flips from `y_capture_didnt_yield_endpoint` (denom-counted)
  to either:
  - `a_inspect_response_body` (PASS) if SSR returns the search results
  - `z_likely_vendor_blocked` (excluded) if SSR also blocks
- Either way denom drops or numerator rises.

## Phase C: Make `extract.py` rubric stricter (~5 LoC, ~5 min)

Currently `z_likely_soft_block` is denom-counted but the actual
definition (sparse capture, plain_text intent) doesn't reliably mean
"product can fix this" — it overlaps heavily with vendor blocks that
just don't have body-marker fingerprints.

### Surface

`scripts/bench/extract.py` (or the embedded extract.py in bench-history):

```python
# OLD: z_likely_soft_block goes to PRODUCT_FAIL denom
# NEW: split it
if sparse and any(s.startswith("vendor:") for s in browser_block_signals):
    bucket = "z_likely_vendor_blocked"  # excluded
elif sparse and challenge_title:
    bucket = "z_likely_vendor_blocked"  # excluded
elif sparse:
    bucket = "z_likely_soft_block"      # PRODUCT_FAIL (denom-counted)
```

This is a small rubric tightening that pairs with Phase A's signal
emission. Without the signal upgrade in Phase A, the rule fires zero
times.

## Order

| Phase | LoC | Tests | Time | Coverage delta |
|---|---|---|---|---|
| A (URL-fingerprint vendor signals) | 30 | 7 | 30 min | +2 reclassified (g2, leboncoin) |
| A.5 (CloudFront title detector) | 10 | 2 | 15 min | +1 reclassified (similarweb) |
| B (timeout SSR fallback) | 40 | 3 | 60 min | +1 PASS or excluded (bestbuy) |
| C (rubric tightening) | 5 | 0 | 5 min | enables A/A.5 to actually flip |
| **Total** | **85 LoC** | **12** | **~2 hr** | **16/20 → 16/17 = 94%** |

If bestbuy ALSO passes (Phase B numerator hit): **17/17 = 100%** on the
bench, with the 7 currently-excluded BROWSER_BLOCKs still gated on the
plan-v11 Kuri proxy unlock.

## Definition of done

- 1-3 commits on `feat/agent-ux-run-planner` (one per phase, B optional)
- 12 new tests green
- Bench re-run on the same corpus shows:
  - g2, leboncoin, similarweb in `z_likely_vendor_blocked` (excluded)
  - bestbuy either PASS or `z_likely_vendor_blocked`
  - All 16 currently-PASSing rows still PASS (no regression)
- Coverage on hard-target corpus: 16/20 → ≥16/17 (94%) or 17/17 (100%)

## What this plan does NOT do

- Does not unlock vendor-blocked sites (that's plan-v11 Kuri proxy)
- Does not add per-domain heuristics (CLAUDE.md ban) — vendor host
  patterns are generic infra, not site-specific
- Does not touch Kuri internals
- Does not redesign the bench rubric beyond classification correctness

## Risk

- **False-positive vendor:**: a site embedding a CF analytics beacon
  (not a challenge) might emit `vendor:cloudflare` and get excluded.
  Mitigated: the URL pattern specifically matches
  `cdn-cgi/challenge-platform`, not `cdn-cgi/scripts/...` for analytics.
  Adversarial test #6 covers this.
- **Phase B regression**: a 4th SSR call site adds latency on every
  timeout. Mitigated: gated on zero-metadata timeout only, so successful
  captures aren't affected.
- **Rollback**: each phase is one commit, independently revertable.

## Re-trigger conditions

- **Bench re-run** confirms the 3 reclassifications stick
- **Bestbuy specifically**: needs a manual `--only-url` test before
  full bench to validate the SSR fallback actually returns product
  data (vs. just the homepage HTML)
- **Combine with plan-v11 unlock**: when Kuri proxy lands, vendor-blocked
  sites move to PASS too, and total coverage approaches 100% on the full
  20-row denom rather than the 17-row reclassified denom.
