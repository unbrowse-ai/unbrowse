# @unbrowse/undici-shim

**One-line drop-in for `undici`. $0 on cache hits, identical undici `ResponseData` shape on miss.**

```diff
- import { request } from 'undici';
+ import { request } from '@unbrowse/undici-shim';

  const { statusCode, headers, body } = await request('https://api.site.com/items');
  const data = await body.json();
```

A safe `GET` routes through Unbrowse's marketplace cache first (free synthesized
undici `ResponseData` on a hit). Every other request — and any `GET` miss — is
performed with the platform's native `fetch` and shaped into undici's response
object `{ statusCode, headers, body }`, where `body` exposes `.text()`,
`.json()`, and `.arrayBuffer()`. The shim also re-exports `fetch` and provides
correctly-shaped `Client`, `Pool`, `Agent`, `setGlobalDispatcher`,
`getGlobalDispatcher`, and `interceptors` so an undici caller's imports compile.

## Install

```bash
npm i @unbrowse/undici-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_UNDICI_PASSTHROUGH=1` to disable cache routing entirely
and go straight to native fetch.

## Honest scope

v0.1 covers the request/response surface most code uses: `request()` (method,
`query`, `body`, `headers`, `signal`, `throwOnError`) and the `body.text()/
.json()/.arrayBuffer()` consume helpers, plus `fetch`. The dispatcher classes
(`Client`/`Pool`/`Agent`) and `interceptors` are shape-correct stubs whose
`request` delegates to the routed `request()` — connection pooling, HTTP/2,
streaming bodies, upgrades, and the full options graph fall through to native
fetch semantics.

## Attribution

This shim mirrors the public surface of [`undici`](https://github.com/nodejs/undici)
(MIT). Semantics are preserved — the shim only lowers cost on cache hits.
