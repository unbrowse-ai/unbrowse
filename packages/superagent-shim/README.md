# @unbrowse/superagent-shim

**One-line drop-in for `superagent`. $0 on cache hits, identical superagent Response shape on miss.**

```diff
- import request from 'superagent';
+ import request from '@unbrowse/superagent-shim';

  const res = await request.get('https://api.site.com/items');
  const res2 = await request('GET', 'https://api.site.com/items').query({ q: 'x' });
```

A safe `GET` routes through Unbrowse's marketplace cache first (free synthesized
superagent `Response` on a hit). Every other request — and any `GET` miss — is
performed with the platform's native `fetch` and shaped into superagent's Response
object `{ status, statusCode, ok, body, text, headers, type }`. Same callable
default `request(method, url)`, same `get/post/put/patch/del/delete/head`, same
chainable thenable Request (`.set/.query/.send/.type/.accept/.timeout`),
`await request.get(url)`, and node-style `.end(callback)`.

## Install

```bash
npm i @unbrowse/superagent-shim
```

No API key required. Set `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` to route paid
endpoints; set `UNBROWSE_SUPERAGENT_PASSTHROUGH=1` to disable cache routing entirely.

## Honest scope

v0.1 covers the request/response surface most code uses (`request(method, url)`,
the method shortcuts, `.set` / `.query` / `.send` / `.type` / `.accept` /
`.timeout`, the thenable/await path, and `.end(callback)`). Plugins (`.use`),
attachments/multipart (`.attach` / `.field`), retries, auth helpers, redirects
config, response streaming, and the full agent/cookie-jar surface fall through to
native fetch semantics.

## Attribution

This shim mirrors the public surface of [`superagent`](https://github.com/ladjs/superagent)
(MIT). Semantics are preserved — the shim only lowers cost on cache hits.
