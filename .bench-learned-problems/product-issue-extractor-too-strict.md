# Product Issue: extractor rejects captured requests on SPA-heavy sites

## Evidence (from 2026-04-11 autonomous session, v3.8.0-preview.2)

Tripadvisor, Zillow, and similar SPA-heavy sites captured **100+ API
calls each** via passive capture, but `extractEndpoints()` in
`src/reverse-engineer/index.ts` returned **zero endpoints**.

### Tripadvisor
- URL: https://www.tripadvisor.com/Hotel_Review-g60763-d1218720-Reviews-The_Plaza-New_York_City_New_York.html
- captured_meta: `html_bytes=0, text_bytes=0, observed_api_calls=122`
- verdict: the browser intercepted 122 requests but extractEndpoints rejected all of them

### Zillow
- URL: https://www.zillow.com/homes/for_sale/San-Francisco-CA/
- captured_meta: `html_bytes=15, text_bytes=15, observed_api_calls=281`
- verdict: 281 requests intercepted, zero endpoints extracted

## Hypothesis

`extractEndpoints()` at `src/reverse-engineer/index.ts:707` applies several
filters that may be too strict for real SPA traffic:

1. **`scoreRequest(req)` → score <= 0 rejection** (line 728-731)
2. **`isApiLike(req)` → not_api_like rejection** (line 724-727)
3. **`hasAdmissibleParsedBody()` → body_not_json_or_html rejection** (line 732,
   only bypassed for `/api/`, `/graphql`, `/youtubei/`, `/__ssr_data__/`, `*.json`)
4. **`affinityDomains` → domain_mismatch rejection** (line 767-779)
5. **`isRscPayload()` → rsc_payload rejection** (line 762)
6. **`looksLikeAdResponse()` → ad rejection** (line 806)

The `traceRows` array inside extractEndpoints already records why each
request was rejected — the agent just needs a way to see it. **Surface
traceRows in the no_endpoints error payload** so captured_meta includes
`filter_rejections: { not_api_like: N, score_non_positive: N, ... }` and
the next agent session can see exactly which filter ate each request.

## Proposed fix (preview.3)

1. Add `filter_rejections` summary to `captured_meta`. Already harmless
   evidence, just expose what the product already tracks in `traceRows`.
2. For each rejected request, log its URL + reason in a new `rejected_urls`
   sample field (first 20) so the agent can inspect them.
3. After both, reevaluate: do the filters need loosening, or are the 281
   zillow requests genuinely all telemetry/analytics (expected reject)?

The fix is not to loosen filters blindly. It's to make the rejections
VISIBLE so the agent can judge whether they were correct.

## Status
Discovered: 2026-04-11 autonomous session
Release that surfaced it: v3.8.0-preview.2 (captured_meta emit)
Fix target: v3.8.0-preview.3
