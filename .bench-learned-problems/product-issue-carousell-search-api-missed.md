# Product Issue: Carousell search captures rec widgets + SSR HTML, misses the real search API

## Symptom (2026-05-14 session)

Intent: "find me shoes on carousell"
URL driven: `https://www.carousell.sg/search/shoes/`
User-visible result: 40+ listings extracted from SSR HTML, ~90% kids/toddler/baby shoes despite the page header reading "100,000+ search results for 'Shoes' in Singapore" with no kids-filter applied. Sort was "Best Match" (default).

Lewis flagged it: results felt wrong, asked us to inspect.

## Evidence

Skill captured: `ei-ksLGuIjp7QPSqOmyhb` (www.carousell.sg) — 6 endpoints, 35 requests.

The 6 captured endpoints (in capture order):

| # | Method + URL | What it actually returns |
|---|---|---|
| 1 | `GET /ds/field-data-proto/cf/rec/1.0/dropped_in_price/` | **Personalized "price dropped" recommendations** widget. Not the search results. |
| 2 | `GET /ds/location-filter-search/1.0/filters/page-info` | Filter sidebar metadata (sort options, category facets). Not results. |
| 3 | `GET /search/shoes` | SSR HTML page — schema.org `@context` block. |
| 4 | `GET /search/shoes` | SSR HTML page — full rendered page. |
| 5 | `GET /search/cats/` | Stale capture from a prior session (different query). |
| 6 | `GET /ds/session?l={l}` | Session bootstrap, not results. |

**None of them is the actual search-results API.** Carousell's real search endpoint (the XHR/proto call that returns the canonical "Best Match" listings array) was either:

- Filtered out by `extractEndpoints` in `src/reverse-engineer/index.ts` (likely path: POST to `/api-service/filter/search/...` or `/ds/filter-search-proto/...` with proto body — same class as the X.com GraphQL `HomeTimeline` POST documented in CLAUDE.md "Known Issues to Fix"), or
- Never fired because the SPA didn't hydrate past initial paint in the time `unbrowse_text` was called.

## Why the user got kids shoes

The text extract pulled what the SSR rendered. Two compounding factors:

1. **Cookie-driven personalization.** `unbrowse_go` injected 30 cookies from Lewis's real Chrome profile. Carousell's SSR `/search/shoes` page uses those cookies to personalize the initial render — including the rec widget (endpoint #1) which is interleaved into the listing grid. So the first ~40 cards reflected his profile/recent activity (or a Carousell demographic guess from the cookies) rather than a neutral "Best Match" view.
2. **No real search API in shortlist.** Because the proto search call wasn't captured, the agent has no way to query for canonical results — every future "search X on carousell" via this skill will re-render SSR + replay the same personalized rec widget, perpetuating the skew.

## Why this matters for the agent UX north star

This violates **Invariant 4: "Works for what was asked."** The agent asked for "shoes" search results; the agent got "shoes that Carousell thinks Lewis personally wants right now." The shortlist also fails **Invariant 2: "Less errors"** — endpoints #1, #2, #5, #6 are all noise for a search intent, only the SSR HTML (#3/#4) is partially relevant.

## Fix hypotheses (ranked)

1. **`extractEndpoints` proto/POST blind spot.** Same root cause as the X.com timeline issue. Add a sniff for `application/x-protobuf` and `application/grpc-web+proto` request/response content-types, and for URL paths matching `/ds/*-proto/`, `/api-service/filter/`, `/api-service/search/`. Score them as API-like even if the body is binary. Test corpus: replay this session's HAR and confirm the search XHR gets through.
2. **Surface `filter_rejections` for the Carousell capture.** Per the existing `product-issue-extractor-too-strict.md`, `traceRows` already knows why each request was dropped. Dump it for this session and we can see exactly which filter ate the search call.
3. **De-personalize search captures.** When intent contains a search keyword and URL matches `/search/*`, optionally retry the page with a clean cookie jar to get the canonical (logged-out) initial render. This is the cheap fix that costs zero capture changes.
4. **Reject rec-widget endpoints from the shortlist for search intents.** Endpoint #1 has `dropped_in_price` in its path — that's a clear rec-widget signal, not a search-results signal. The ranker (or the description LLM in `generateLocalDescription`) should down-rank endpoints whose path contains `rec/`, `recommendation`, `dropped_in_price`, `for_you`, `personalized` when the intent is a generic search.

Be careful with #4 — that's site-specific-pattern-shaped. Better wording: down-rank any endpoint whose response schema lacks the dominant repeating array shape that the intent's URL path implies. (The page is `/search/shoes`, the schema we want is an array of listings, and `dropped_in_price` returns a different shape of recs.) Generalises.

## Reproduction

```bash
# Cold session, fresh cookies
pkill -9 -f 'unbrowse|kuri' && sleep 2
unbrowse go "https://www.carousell.sg/search/shoes/"
unbrowse text  # observe kids-shoe skew
unbrowse close # observe 6 endpoints captured, no search API
```

Cross-check with HAR dump for the session to confirm whether the proto search call fired at all.

## Status

- Discovered: 2026-05-14, ad-hoc user request ("find me shoes on carousell")
- Skill ID for forensics: `ei-ksLGuIjp7QPSqOmyhb`
- Related: `product-issue-extractor-too-strict.md` (same filter family), CLAUDE.md "Known Issues" entry for X.com GraphQL timeline (same proto-POST blind spot)
- Fix target: next preview release after extractor proto-POST sniff lands
