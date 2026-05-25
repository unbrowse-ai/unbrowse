# @unbrowse/firecrawl-shim

**One-line drop-in for `@mendable/firecrawl-js`. $0 on cache hits.**

```diff
- import Firecrawl from '@mendable/firecrawl-js';
+ import Firecrawl from '@unbrowse/firecrawl-shim';

  const client = new Firecrawl({ apiKey: 'fc-xxx' });
  const doc = await client.scrape('https://example.com');
```

`scrape / map / crawl / extract / search` all routed through Unbrowse's marketplace cache first. Cache hit → free synthesized `Document`. Miss → falls back to Firecrawl with your original `fc-xxx` key so you pay them only when we miss.

## Install

```bash
npm i @unbrowse/firecrawl-shim
```

No additional setup — your existing Firecrawl API key works as the fallback authenticator.

## Env

| Var | Meaning |
|---|---|
| `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` | Auth for Unbrowse path |
| `FIRECRAWL_API_KEY` | Already-set fallback (or pass `apiKey` to the constructor) |
| `UNBROWSE_API_URL` | Override default `https://beta-api.unbrowse.ai` |

## Coverage

| Method | Cache hit | Fallback |
|---|---|---|
| `scrape(url, opts)` | ✅ Unbrowse marketplace → synthesized Document | ✅ Firecrawl /v1/scrape |
| `extract(urls, {schema})` | ✅ Per-URL Unbrowse execute --extract | partial (per-URL fallback in v0.2) |
| `map(url)` | not in v0.1 (sitemap index TODO) | ✅ Firecrawl /v1/map |
| `crawl(url, opts)` | not in v0.1 (recursive plan TODO) | ✅ Firecrawl /v1/crawl |
| `search(query)` | not in v0.1 | ✅ Firecrawl /v2/search |

The shim is **safe to drop in**: if Unbrowse hasn't indexed your target URL yet, your call still works against Firecrawl with your existing key. The only thing that changes is your bill.

## Cost comparison

Firecrawl's pricing model: **1 credit = 1 page scraped/crawled/mapped, 2 credits = 10 search results, 2 credits = 1 browser-min Interact.** Plans: Hobby $16/5k credits · Standard $83/100k · Growth $333/500k · Scale $599/1M.

| Scenario | Firecrawl | Unbrowse shim |
|---|---|---|
| Scrape 100k pages already in marketplace | $83 (Standard tier) | $0 |
| Scrape 100k pages, 60% cached | $83 | $33 ($0 on 60% hits, Firecrawl fallback on 40%) |
| Scrape 100k pages, 0% cached | $83 | $83 (fallthrough, no Unbrowse cost) |

The break-even is at 0% cache hit rate, where you pay the same as Firecrawl. Anything above that is pure savings.

## Stickiness loop

Every fallthrough Firecrawl scrape gets its captured route published back to Unbrowse's marketplace under your wallet. Next call from anywhere — yours, or any other agent — becomes a cache hit. You earn x402 micropayments when other callers hit your contributed routes. Pay Firecrawl once, get paid forever.

## License

MIT.
