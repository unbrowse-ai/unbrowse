# @unbrowse/tavily-shim

**One-line drop-in for `@tavily/core`. $0 on cache hits.**

```diff
- import { tavily } from '@tavily/core';
+ import { tavily } from '@unbrowse/tavily-shim';

  const client = tavily({ apiKey: 'tvly-xxx' });
  const res = await client.search('who founded unbrowse');
```

`search / searchQNA / searchContext / extract` all route through Unbrowse's marketplace cache first (`/v1/resolve` with the query as intent + `/v1/execute` on the top candidate). Cache hit → free synthesized Tavily-shaped results. Miss → falls back to the real Tavily API with your original `tvly-xxx` key, so you pay them only when we miss.

## Install

```bash
npm i @unbrowse/tavily-shim
```

No additional setup — your existing Tavily API key works as the fallback authenticator.

## Env

| Var | Meaning |
|---|---|
| `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` | Auth for the Unbrowse path |
| `TAVILY_API_KEY` | Already-set fallback (or pass `apiKey` to the factory) |
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | Override default `https://beta-api.unbrowse.ai` |
| `UNBROWSE_DRYRUN=1` | Deterministic offline path: `search` returns `{ query, results: [] }` with no network |

## Coverage

| Method | Cache hit | Fallback |
|---|---|---|
| `search(query, opts)` | ✅ Unbrowse resolve+execute → synthesized `SearchResponse` | ✅ Tavily `/search` |
| `searchQNA(query, opts)` (= `qnaSearch`) | ✅ derived answer from top result | ✅ via `search` fallback |
| `searchContext(query, opts)` | ✅ joined result contents | ✅ via `search` fallback |
| `extract(urls, opts)` | ✅ per-URL resolve+execute raw content | ✅ Tavily `/extract` for misses |

## Honest scope

This is a **drop-in** for the public surface of `@tavily/core` — the named `tavily` factory and its `search` / `searchQNA` / `qnaSearch` / `searchContext` / `extract` methods. It is **not** a reimplementation of Tavily's ranking model. On an Unbrowse cache hit it synthesizes Tavily-shaped results from the resolved route shortlist; on a miss it transparently forwards to Tavily's own API when a key is present. With neither a cache hit nor a Tavily key, `search` returns an empty result set (it does not throw) — same shape Tavily returns for zero hits. Relevance scores on synthesized results are positional, not Tavily's semantic score.

## License

MIT.
