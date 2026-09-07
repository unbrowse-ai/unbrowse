# @unbrowse/cross-fetch-shim

**One-line drop-in for `cross-fetch`. $0 on cache hits, identical semantics on miss.**

```diff
- import fetch from 'cross-fetch';
+ import fetch from '@unbrowse/cross-fetch-shim';

  const res = await fetch('https://api.site.com/items');
  const json = await res.json();
```

`cross-fetch` is a universal `fetch` ponyfill. This shim keeps that exact surface
— default `fetch` plus named `fetch`, `Headers`, `Request`, `Response` — but routes
a safe `GET` through Unbrowse's marketplace cache first (free synthesized
`Response` on a hit) and falls straight through to the platform's native `fetch`
on a miss, so behaviour is identical.

## Install

```bash
npm i @unbrowse/cross-fetch-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_CROSS_FETCH_PASSTHROUGH=1` to disable cache routing.

## Attribution

This shim mirrors the public surface of
[`cross-fetch`](https://github.com/lquixada/cross-fetch) (MIT). On a cache miss it
is exactly the ponyfilled fetch — the shim only lowers cost on hits.
