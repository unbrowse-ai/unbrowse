# BUG: Garbage DOM Extractions Get Indexed Into Marketplace

## Problem

When capturing Cloudflare-protected SPAs (e.g. StockTwits), Unbrowse produces garbage data — duplicates, concatenated strings, navigation elements — and publishes it to the shared marketplace where other agents discover and reuse it.

### Example garbage output (StockTwits before fix)

```json
[
  {"title": "AAPLApple Inc", "info": "AAPLApple Inc978,583"},
  {"title": "AAPLApple Inc", "info": "AAPLApple Inc978,583"},
  {"title": "NVDANvidia", "info": "NVDANvidia1,200,000"}
]
```

- Ticker symbols jammed onto company names: `AAPLApple`, `NVDANvidia`
- Numbers concatenated without separators: `Inc978,583`
- Exact duplicate rows
- Navigation chrome extracted instead of page content

This passes the current quality bar (`confidence > 0.2`) and gets published with `lifecycle: "active"` and `index_status: "ok"`, polluting the marketplace for all agents.

## Root Causes

### 1. SPA embedded data is destroyed before extraction

`cleanDOM()` in `extraction/index.ts` (line 52) strips **all** `<script>` tags except `type="application/ld+json"`. This destroys rich structured JSON embedded by SPA frameworks:

- Next.js: `<script id="__NEXT_DATA__" type="application/json">`
- Nuxt.js: `window.__NUXT__={...}`
- Generic: `window.__INITIAL_STATE__={...}`, `window.__PRELOADED_STATE__={...}`

StockTwits is a Next.js app — all its page data (discussions, news, user profiles) lives in `__NEXT_DATA__`. After `cleanDOM()` strips it, the extractor falls back to scraping visible DOM elements and produces garbage.

### 2. No quality gate before marketplace publishing

In `execution/index.ts` (line 143), the only check before publishing a DOM-extracted skill is `extracted.confidence > 0.2`. There's no validation of the actual data quality. Garbage like concatenated strings and duplicate rows passes this bar.

### 3. Flat 5-second wait is too short for Cloudflare sites

`capture/index.ts` (line 188) has a flat `await new Promise((r) => setTimeout(r, 5000))` after navigation. On Cloudflare-protected sites, the JS challenge eats 3-5 seconds of this window, leaving no time for the SPA's actual API calls to fire. Result: only 17 requests captured, all Cloudflare infrastructure — no real data endpoints.

## Fix

### Fix 1: Extract SPA-embedded data (`extraction/index.ts`)

Add `extractSPAData(html)` that parses raw HTML **before** `cleanDOM()` strips scripts:

- `<script id="__NEXT_DATA__">` → parse JSON, extract `props.pageProps`
- `window.__NUXT__={...}` → extract `data[0]` or `state`
- `window.__INITIAL_STATE__` / `window.__PRELOADED_STATE__` → extract JSON

Call it in `extractFromDOM()` before `cleanDOM()`, merge results:
```ts
const spaStructures = extractSPAData(html);  // raw HTML
const cleaned = cleanDOM(html);
const structures = [...spaStructures, ...parseStructured(cleaned)];
```

Add SPA types to scoring: `spa-nextjs` → confidence 0.9, others → 0.85, relevance bonus +3.

### Fix 2: Quality gate before publishing (`execution/index.ts`)

Add `validateExtractionQuality(data, confidence)` with checks:

- **Min confidence**: Reject if < 0.5
- **Deduplication**: Remove exact JSON dupes; reject if > 50% are duplicates
- **Concatenation detection**: Flag strings matching `/[A-Z]{2,}[A-Z][a-z]/` (e.g. `AAPLApple`) or `/[a-zA-Z]\d{3,}/` (e.g. `Inc978`); reject if > 30% of string values
- **Diversity**: Reject if all items share the same `link`, `href`, `url`, or `title` (navigation chrome)

**Always return data to the caller** (agent can decide what to do with it). **Only publish to marketplace if quality passes.** Surface `quality_note` in `_extraction` metadata when blocked.

### Fix 3: Adaptive Cloudflare wait (`capture/index.ts`)

Replace the flat 5-second wait with `waitForContentReady(browser)`:

- **Phase 1**: 2s initial settle
- **Phase 2**: Check for CF markers (`challenge-platform`, `cf_chl_opt`, `Just a moment...`). If found, poll every 1.5s for up to 15s until cleared.
- **Phase 3**: `page.waitForLoadState("networkidle", { timeout: 8000 })` for SPA API calls

Worst case: 2s + 15s + 8s = 25s, well within the 90s `CAPTURE_TIMEOUT_MS`.

## Verification

After applying fixes, StockTwits capture returns:

```
extraction method: spa-nextjs
confidence: 1.0
data: 12 discussions, 12 news articles, user profiles, timestamps
```

Before: garbage concatenated nav elements at confidence 0.6, published to marketplace.
After: structured Next.js pageProps at confidence 1.0, quality gate passes.

## Files Changed

| File | Change |
|------|--------|
| `src/extraction/index.ts` | Add `extractSPAData()`, `countDataElements()`, SPA scoring |
| `src/execution/index.ts` | Add `validateExtractionQuality()`, `isConcatenatedValue()`, gate publish |
| `src/capture/index.ts` | Add `waitForContentReady()`, CF markers, replace flat wait |
