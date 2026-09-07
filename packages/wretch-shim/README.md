# @unbrowse/wretch-shim

**One-line drop-in for `wretch`. $0 on cache hits, identical wretch chain on miss.**

```diff
- import wretch from 'wretch';
+ import wretch from '@unbrowse/wretch-shim';

  const data = await wretch('https://api.site.com/items').get().json();
  await wretch('https://api.site.com').post({ name: 'x' }, '/items').res();
```

A safe `GET` routes through Unbrowse's marketplace cache first (free synthesized
response on a hit). Every other request — and any `GET` miss — is performed with
the platform's native `fetch`. Same callable default, same `url/headers/auth/
content/query/options/accept` config chain, same `json/body/formData` body
setters, same `get/post/put/patch/delete/head` verbs, same thenable
`ResponseChain` (`await wretch(url).get()` → Response; `.json()/.text()/.res()/
.arrayBuffer()` → parsed body; `.notFound()/.error(code)` → status catchers).

## Install

```bash
npm i @unbrowse/wretch-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_WRETCH_PASSTHROUGH=1` to disable cache routing entirely.

## Honest scope

v0.1 covers the request/response surface most code uses (the `url/headers/auth/
content/query/options/accept` chain, `json`/`body`/`formData` setters, all six
verbs, and the `json/text/res/arrayBuffer` + `notFound/error` ResponseChain).
Middlewares, addons (`wretch().addon(...)`), abort/retry/dedupe policies, and the
full options graph fall through to native fetch semantics.

## Attribution

This shim mirrors the public surface of [`wretch`](https://github.com/elbywan/wretch)
(MIT). Semantics are preserved — the shim only lowers cost on cache hits.
