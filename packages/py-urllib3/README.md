# unbrowse-urllib3

A **drop-in** for `urllib3`. Swap one import and your existing code keeps working
— GET requests are routed through Unbrowse's resolve/execute API (which returns
clean structured data from a maintained route graph), and anything that misses
falls back to a plain Python `urllib.request` call. No third-party dependencies.

## Swap

```python
import unbrowse_urllib3 as urllib3

http = urllib3.PoolManager()
resp = http.request("GET", "https://example.com/api/thing")
print(resp.status)
print(resp.json())

# urllib3 2.x top-level style also works:
resp = urllib3.request("GET", "https://example.com/api/thing")
```

The familiar surface is preserved: `PoolManager.request(method, url, fields=...,
headers=..., body=...)`, the top-level `urllib3.request(...)`, and an
`HTTPResponse` with `.status`, `.data` (bytes), `.headers`, plus `.json()`,
`.read()`, `.geturl()`, and `.decode_content`. `disable_warnings()` is a no-op,
and `PoolManager(...)` accepts arbitrary keyword arguments.

## Configuration

| Env var | Meaning |
|---|---|
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | API base (default `https://beta-api.unbrowse.ai`) |
| `UNBROWSE_API_KEY` | bearer token |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | x402 payment header |
| `UNBROWSE_DRYRUN=1` | synthesize a `200` with body `{"dryrun": true}`, no network |

## Honest scope note

This is a compatibility shim, **not** a full re-implementation of `urllib3`. Only
the high-level request surface used by typical code is covered. GET routing goes
through Unbrowse's resolve -> execute path; non-GET methods and cache misses fall
back to stdlib `urllib.request`. Advanced urllib3 features (connection pooling and
reuse, retries/`Retry`, redirects config, streaming/`preload_content=False`,
multipart encoding, proxy managers, custom SSL contexts) are **not** implemented.
If your code depends on those, keep upstream `urllib3`.

Learn more: https://unbrowse.ai/vs/urllib3
