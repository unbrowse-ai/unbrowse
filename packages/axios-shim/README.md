# @unbrowse/axios-shim

**One-line drop-in for `axios`. $0 on cache hits, identical response shape on miss.**

```diff
- import axios from 'axios';
+ import axios from '@unbrowse/axios-shim';

  const { data } = await axios.get('https://api.site.com/items');
  const res = await axios.post('https://api.site.com/items', { name: 'x' });
```

A safe `GET` routes through Unbrowse's marketplace cache first (free synthesized
axios response on a hit). Every other request — and any `GET` miss — is performed
with the platform's native `fetch` and shaped into the exact axios response
object `{ data, status, statusText, headers, config, request }`. Same callable
default, same `get/post/put/patch/delete/head/options`, same `create()`,
`interceptors`, `isAxiosError`, `AxiosError`, `CancelToken`, `all`, `spread`.

## Install

```bash
npm i @unbrowse/axios-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_AXIOS_PASSTHROUGH=1` to disable cache routing entirely.

## Honest scope

v0.1 covers the request/response surface most code uses (config, params, data,
headers, `responseType`, `validateStatus`, request/response interceptors,
`create()`). Node-stream `responseType: 'stream'`, the full transform pipeline,
and proxy/adapter overrides fall through to native fetch semantics.

## Attribution

This shim mirrors the public surface of [`axios`](https://github.com/axios/axios)
(MIT). Semantics are preserved — the shim only lowers cost on cache hits.
