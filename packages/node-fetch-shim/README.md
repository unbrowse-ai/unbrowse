# @unbrowse/node-fetch-shim

**One-line drop-in for `node-fetch`. $0 on cache hits, identical semantics on miss.**

```diff
- import fetch from 'node-fetch';
+ import fetch from '@unbrowse/node-fetch-shim';

  const res = await fetch('https://api.site.com/items');
  const json = await res.json();
```

A safe `GET` routes through Unbrowse's marketplace cache first. Cache hit → free
synthesized `Response`. Miss → falls straight through to the platform's native
`fetch`, so behaviour is identical to `node-fetch`. Anything non-`GET` is a pure
pass-through.

## Install

```bash
npm i @unbrowse/node-fetch-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_NODE_FETCH_PASSTHROUGH=1` to disable routing entirely
(pure native fetch).

## Surface

Mirrors `node-fetch`: default export `fetch`, plus named `fetch`, `Headers`,
`Request`, `Response`, `Blob`, `FormData`, `FetchError`, `AbortError`,
`isRedirect`.

## Attribution

This shim mirrors the public surface of
[`node-fetch`](https://github.com/node-fetch/node-fetch) (MIT). It exists to
lower its callers' egress cost — on a cache miss it is exactly native fetch /
node-fetch, never a behavioural replacement.
