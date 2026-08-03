# @unbrowse/ky-shim

**One-line drop-in for `ky`. $0 on cache hits, native `Response` on miss.**

```diff
- import ky from 'ky';
+ import ky from '@unbrowse/ky-shim';

  const data = await ky('https://api.site.com/items').json();
  const res = await ky.post('https://api.site.com/items', { json: { name: 'x' } });
```

`ky` is already fetch-based, so the swap is exact. A safe `GET` routes through
Unbrowse's marketplace cache first (free synthesized `Response` on a hit) and
falls through to native `fetch` on a miss. The call returns ky's `ResponsePromise`
— a `Promise<Response>` augmented with `.json()/.text()/.blob()/.arrayBuffer()/
.formData()`. Same callable default, `get/post/put/patch/delete/head`, `create()`,
`extend()`, `HTTPError`/`TimeoutError`, throw-on-non-2xx.

## Install

```bash
npm i @unbrowse/ky-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_KY_PASSTHROUGH=1` to disable cache routing entirely.

## Honest scope

v0.1 covers the request/response surface most code uses (method, `prefixUrl`,
`searchParams`, `json`, `headers`, `timeout`, `throwHttpErrors`, `create()`,
`extend()`). The `hooks`, `retry`, and `onDownloadProgress` option graphs fall
through to native fetch semantics.

## Attribution

This shim mirrors the public surface of [`ky`](https://github.com/sindresorhus/ky)
(MIT). Semantics are preserved — the shim only lowers cost on cache hits.
