# Python Adapters

Unbrowse is a drop-in for the Python layer too. Whether your code uses the
most-loved HTTP client on earth or builds agents with a Python framework, you keep
your exact API and route through Unbrowse with one import swap.

Each adapter is **pure stdlib** — no third-party install is required for the
fallback path, so the shim works even where the upstream isn't installed. A safe
`GET` first routes through Unbrowse's resolve + execute marketplace cache (free on a
hit); a miss or non-GET falls back to a native `urllib` request. Set
`UNBROWSE_DRYRUN=1` for offline, deterministic calls. Each package ships a parity
test proving it provides the upstream's surface (`scripts/python-adapter-gate.sh`).

Config (optional): `UNBROWSE_API_URL`, `UNBROWSE_API_KEY`, `UNBROWSE_X_PAYMENT`.

## HTTP clients (drop-in)

| Upstream | Adapter | Swap |
|---|---|---|
| `requests` | `unbrowse-requests` | `import unbrowse_requests as requests` |
| `httpx` | `unbrowse-httpx` | `import unbrowse_httpx as httpx` |
| `aiohttp` | `unbrowse-aiohttp` | `import unbrowse_aiohttp as aiohttp` |
| `urllib3` | `unbrowse-urllib3` | `import unbrowse_urllib3 as urllib3` |

```python
# before:  import requests
import unbrowse_requests as requests

r = requests.get("https://api.site.com/items")   # unchanged
print(r.status_code, r.json())
```

`requests` provides `get/post/put/patch/delete/head/request`, `Session`, and a
`Response` with `.status_code`/`.text`/`.json()`/`.ok`/`.raise_for_status()`.
`httpx` adds sync `Client` + async `AsyncClient`. `aiohttp` provides the async
`ClientSession` context-manager surface. `urllib3` provides `PoolManager.request`
and the top-level `request()` returning an `HTTPResponse`.

## Agent SDKs (native tool)

| Upstream | Adapter | Tool type |
|---|---|---|
| `crewai` | `unbrowse-crewai` | `BaseTool` (`name`/`description`/`_run`) |
| `pydantic-ai` | `unbrowse-pydantic-ai` | `Tool(function, name, description)` |

```python
from unbrowse_crewai import unbrowse_tools
from crewai import Agent

agent = Agent(role="researcher", tools=unbrowse_tools)   # resolve / execute / search
```

Each exposes `unbrowse_resolve`, `unbrowse_execute`, and `unbrowse_search`. For
framework-branded instances, call `create_unbrowse_tools(BaseTool)` (CrewAI) or
`create_unbrowse_tools(Tool)` (Pydantic AI) and pass the framework's own class.

## MCP

Python agent hosts that speak MCP can also use Unbrowse directly with no package at
all — run `npx unbrowse mcp`. See [Agent SDK Adapters](./agent-sdk-adapters.md).

## Honest scope

A drop-in preserves the upstream's **public API surface**, not every private
internal. The HTTP adapters use Python's stdlib `urllib` for the fallback, so they
do not require the upstream package installed; the agent adapters expose tools in the
framework's contract and provide a factory for framework-branded instances. See also
[Drop-in Adapters](./drop-in-adapters.md) (JavaScript) and
[Integration Surfaces](./integration-surfaces.md).
