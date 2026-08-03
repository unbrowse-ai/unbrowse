# unbrowse-requests

A zero-edit **drop-in** for the [`requests`](https://github.com/psf/requests)
library. Swap one import and your code keeps working:

```python
# - import requests
import unbrowse_requests as requests

r = requests.get("https://api.example.com/items")
print(r.status_code, r.json())
```

It exposes the same surface you already use: the module functions `get`, `post`,
`put`, `patch`, `delete`, `head`, `options`, `request`; a `Session` class (with
`.headers` and context-manager support); a `Response` with `.status_code`,
`.text`, `.content`, `.headers`, `.url`, `.ok`, `.reason`, `.json()`,
`.raise_for_status()`, and `.iter_content()`; and the familiar exception
hierarchy `RequestException`, `HTTPError`, `ConnectionError`, `Timeout`.

## How it routes

- A **safe GET** first tries Unbrowse's resolve + execute marketplace cache
  (`/v1/resolve` → `/v1/execute`). On a hit, the upstream `Response` is
  synthesized from the cached body — no live round-trip needed.
- Any **miss**, any **non-GET** method, or `UNBROWSE_REQUESTS_PASSTHROUGH=1`
  falls back to a native HTTP call performed with the Python **stdlib**
  (`urllib.request`).

## Honest scope

This is a stdlib-backed compatibility shim, not a re-implementation of all of
`requests`. The fallback path uses `urllib.request`, so there is **no
third-party dependency to install**. GET requests route through Unbrowse;
everything else is a direct stdlib request. Streaming, cookies/auth objects,
adapters, retries, and proxies are not modelled — only the common request/
response surface above. Set `UNBROWSE_DRYRUN=1` to short-circuit all network and
get a synthetic `200` response (useful for offline tests).

## Environment

| Variable | Effect |
|---|---|
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | Override the Unbrowse base URL |
| `UNBROWSE_API_KEY` | Sent as `Authorization: Bearer …` |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | Sent as the `x-payment` header |
| `UNBROWSE_REQUESTS_PASSTHROUGH=1` | Skip the cache; always do a native call |
| `UNBROWSE_DRYRUN=1` | No network; return a synthetic `{"dryrun": true}` 200 |

MIT licensed. See https://unbrowse.ai/vs/requests.
