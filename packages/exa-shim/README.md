# @unbrowse/exa-shim

**One-line drop-in for `exa-js`. $0 on cache hits.**

```diff
- import Exa from 'exa-js';
+ import Exa from '@unbrowse/exa-shim';

  const exa = new Exa('exa-xxx');
  const { results } = await exa.search('latest research on LLM agents');
  const { results } = await exa.searchAndContents('...', { numResults: 5 });
```

`search / searchAndContents / getContents / findSimilar / findSimilarAndContents / answer` all route through Unbrowse's resolved-route cache first (`/v1/resolve` with your query as the intent, `/v1/execute` on the top candidate). Cache hit → free synthesized `SearchResult`s. Miss → falls back to Exa's own API with your original `exa-xxx` key, so you pay Exa only when we miss.

## Install

```bash
npm i @unbrowse/exa-shim
```

No additional setup — your existing Exa API key works as the fallback authenticator (constructor arg or `EXA_API_KEY`).

## Env

| Var | Meaning |
|---|---|
| `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` | Auth for the Unbrowse path |
| `EXA_API_KEY` | Already-set fallback key (or pass it to the constructor) |
| `UNBROWSE_API_URL` | Override default `https://beta-api.unbrowse.ai` |
| `UNBROWSE_DRYRUN=1` | Deterministic offline mode: returns empty results with no network (for tests) |

## Coverage (honest scope)

| Method | Cache hit | Fallback (needs `EXA_API_KEY`) |
|---|---|---|
| `search(query, opts)` | ✅ resolve+execute → synthesized results | ✅ Exa `/search` |
| `searchAndContents(query, opts)` | ✅ results carry `text`/`highlights`/`summary` | ✅ Exa `/search` with `contents` |
| `getContents(ids, opts)` | ✅ per-id resolve+execute fills `text` | ✅ Exa `/contents` |
| `findSimilar(url, opts)` | ✅ url as resolve intent | ✅ Exa `/findSimilar` |
| `findSimilarAndContents(url, opts)` | ✅ similar + contents | ✅ Exa `/findSimilar` with `contents` |
| `answer(query, opts)` | ✅ stitched from cached search + citations | ✅ Exa `/answer` (real generative answer) |

The shim is **safe to drop in**: if Unbrowse hasn't indexed your target yet, your call still works against Exa with your existing key. The only thing that changes is your bill. A truly generative `answer()` needs the Exa fallback key; the cache path stitches an extractive answer with citations.

## License

MIT.
