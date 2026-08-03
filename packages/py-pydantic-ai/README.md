# unbrowse-pydantic-ai

Native [Unbrowse](https://unbrowse.ai) tools for [pydantic-ai](https://github.com/pydantic/pydantic-ai).

Gives a Pydantic AI agent three tools backed by the Unbrowse agent internet layer:

- `unbrowse_resolve(url, intent)` — resolve a URL + intent to a ranked API endpoint shortlist.
- `unbrowse_execute(endpoint_id, params=None)` — execute a resolved endpoint.
- `unbrowse_search(query, url=None)` — resolve the query as intent, pick the top endpoint, and execute it.

Each tool is a plain function returning a JSON string.

## Install

```bash
pip install unbrowse-pydantic-ai
```

## Register the tools

Pydantic AI tools are plain functions registered via `Tool(...)`. Pass Pydantic
AI's real `Tool` to the factory to get registered tools:

```python
from pydantic_ai import Agent, Tool
from unbrowse_pydantic_ai import create_unbrowse_tools

agent = Agent(
    "openai:gpt-4o",
    tools=create_unbrowse_tools(Tool),
)
```

You can also use the exported plain functions directly:

```python
from pydantic_ai import Agent
from unbrowse_pydantic_ai import unbrowse_resolve, unbrowse_execute, unbrowse_search

agent = Agent("openai:gpt-4o", tools=[unbrowse_resolve, unbrowse_execute, unbrowse_search])
```

`unbrowse_tools` is also exported as a list of
`{"name", "description", "function"}` dicts for custom registration.

## Configuration

Set via environment variables:

- `UNBROWSE_API_KEY` — bearer token (optional).
- `UNBROWSE_API_URL` / `UNBROWSE_BASE` — API base (default `https://beta-api.unbrowse.ai`).
- `UNBROWSE_X_PAYMENT` / `X_PAYMENT` — x402 payment header (optional).
- `UNBROWSE_DRYRUN=1` — return synthesized JSON, no network (used by the offline test).

## Scope

Honest scope: this is a thin tool adapter. It wraps three Unbrowse HTTP
endpoints (`/v1/resolve`, `/v1/execute`) using only the Python standard library.
It does not vendor the Pydantic AI runtime, manage sessions, or perform browser
capture — for capture-based flows use the Unbrowse CLI/MCP. Network calls
require a reachable Unbrowse API; the test suite runs fully offline via
`UNBROWSE_DRYRUN=1`.

MIT licensed.
