# unbrowse-httpx

A zero-edit **drop-in** for the [`httpx`](https://github.com/encode/httpx)
library. Swap one import and your code keeps working:

```python
# - import httpx
import unbrowse_httpx as httpx

r = httpx.get("https://api.example.com/items")
print(r.status_code, r.json())

with httpx.Client() as client:
    r = client.get("https://api.example.com/items")
```

It exposes the same surface you already use: the module functions `get`, `post`,
`put`, `patch`, `delete`, `head`, `options`, `request`; a sync `Client` and an
`AsyncClient` (both with `.headers` and context-manager support, the async one
usable via `async with`); a `Response` with `.status_code`, `.text`, `.content`,
`.headers`, `.url`, `.json()`, `.raise_for_status()`; the `codes` status-code
constants; and the exceptions `HTTPError`, `RequestError`, `HTTPStatusError`.

## How it routes

- A **safe GET** first tries Unbrowse's resolve + execute marketplace cache
  (`/v1/resolve` → `/v1/execute`). On a hit, the upstream `Response` is
  synthesized from the cached body — no live round-trip needed.
- Any **miss**, any **non-GET** method, or `UNBROWSE_HTTPX_PASSTHROUGH=1`
  falls back to a native HTTP call performed with the Python **stdlib**
  (`urllib.request`).

## Honest scope

This is a stdlib-backed compatibility shim, not a re-implementation of all of
`httpx`. The fallback path uses `urllib.request`, so there is **no third-party
dependency to install**. GET requests route through Unbrowse; everything else is
a direct stdlib request. HTTP/2, real async I/O (the `AsyncClient` runs the same
synchronous path), streaming, transports, and connection pooling are not
modelled — only the common request/response surface above. Set
`UNBROWSE_DRYRUN=1` to short-circuit all network and get a synthetic `200`
response (useful for offline tests).

## Environment

| Variable | Effect |
|---|---|
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | Override the Unbrowse base URL |
| `UNBROWSE_API_KEY` | Sent as `Authorization: Bearer …` |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | Sent as the `x-payment` header |
| `UNBROWSE_HTTPX_PASSTHROUGH=1` | Skip the cache; always do a native call |
| `UNBROWSE_DRYRUN=1` | No network; return a synthetic `{"dryrun": true}` 200 |

MIT licensed. See https://unbrowse.ai/vs/httpx.
