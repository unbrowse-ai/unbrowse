# @unbrowse/got-shim

**One-line drop-in for `got`. $0 on cache hits, identical got Response shape on miss.**

```diff
- import got from 'got';
+ import got from '@unbrowse/got-shim';

  const { body, statusCode } = await got('https://api.site.com/items');
  const data = await got('https://api.site.com/items').json();
```

A safe `GET` routes through Unbrowse's marketplace cache first (free synthesized
got `Response` on a hit). Every other request — and any `GET` miss — is performed
with the platform's native `fetch` and shaped into got's Response object
`{ body, statusCode, statusMessage, headers, url }`. Same callable default, same
`get/post/put/patch/delete/head`, same `extend()`, same augmented promise
(`await got(url)` → Response; `.json()/.text()/.buffer()` → parsed body), same
`HTTPError`/`RequestError`.

## Install

```bash
npm i @unbrowse/got-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_GOT_PASSTHROUGH=1` to disable cache routing entirely.

## Honest scope

v0.1 covers the request/response surface most code uses (method, `prefixUrl`,
`searchParams`, `json`/`body`, `headers`, `responseType`, `throwHttpErrors`,
`extend()`). Streaming (`got.stream`), pagination (`got.paginate`), retry/hooks,
and the full options graph fall through to native fetch semantics.

## Attribution

This shim mirrors the public surface of [`got`](https://github.com/sindresorhus/got)
(MIT). Semantics are preserved — the shim only lowers cost on cache hits.
