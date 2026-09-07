# unbrowse-aiohttp

A **drop-in** for the `aiohttp` client. Swap one import and your existing async
HTTP code keeps working — GET requests are routed through Unbrowse's
resolve/execute API (which returns clean structured data from a maintained route
graph), and anything that misses falls back to a plain Python `urllib.request`
call. No third-party dependencies.

## Swap

```python
import unbrowse_aiohttp as aiohttp

async with aiohttp.ClientSession() as s:
    async with s.get("https://example.com/api/thing") as resp:
        print(resp.status)
        print(await resp.json())
```

The familiar surface is preserved: `ClientSession` (async context manager) with
`.get/.post/.put/.patch/.delete/.head/.request`, each returning a response that is
itself an async context manager with `.status`, `.headers`, `.url`,
`.text()`, `.json()`, `.read()`, and `.raise_for_status()`. Plus `ClientTimeout`,
`ClientError`, and `ClientResponseError`.

## Configuration

| Env var | Meaning |
|---|---|
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | API base (default `https://beta-api.unbrowse.ai`) |
| `UNBROWSE_API_KEY` | bearer token |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | x402 payment header |
| `UNBROWSE_DRYRUN=1` | synthesize a `200` with body `{"dryrun": true}`, no network |

## Honest scope note

This is a compatibility shim, **not** a full re-implementation of `aiohttp`. Only
the high-level client surface used by typical request code is covered. GET routing
goes through Unbrowse's resolve -> execute path; non-GET methods and cache misses
fall back to stdlib `urllib.request` (run in a thread). Advanced aiohttp features
(streaming bodies, multipart, websockets, connector/SSL tuning, cookie jars,
trace configs) are **not** implemented. If your code depends on those, keep
upstream `aiohttp`.

Learn more: https://unbrowse.ai/vs/aiohttp
