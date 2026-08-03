# unbrowse-crewai

Native [Unbrowse](https://unbrowse.ai) tools for [crewai](https://github.com/crewAIInc/crewAI).

Gives a CrewAI agent three tools backed by the Unbrowse agent internet layer:

- `unbrowse_resolve(url, intent)` — resolve a URL + intent to a ranked API endpoint shortlist.
- `unbrowse_execute(endpoint_id, params=None)` — execute a resolved endpoint.
- `unbrowse_search(query, url=None)` — resolve the query as intent, pick the top endpoint, and execute it.

Each tool returns a JSON string.

## Install

```bash
pip install unbrowse-crewai
```

## Register the tools

When `crewai` is installed, build real CrewAI tools by passing in its `BaseTool`:

```python
from crewai import Agent
from crewai.tools import BaseTool
from unbrowse_crewai import create_unbrowse_tools

unbrowse_tools = create_unbrowse_tools(BaseTool)

agent = Agent(
    role="Researcher",
    goal="Answer with live data",
    backstory="Uses Unbrowse to reach real APIs.",
    tools=unbrowse_tools,
)
```

The module also exports a ready-to-use `unbrowse_tools` list (built on a local
minimal base so the package imports with no third-party dependency):

```python
from unbrowse_crewai import unbrowse_tools

# Agent(tools=unbrowse_tools)
```

## Configuration

Set via environment variables:

- `UNBROWSE_API_KEY` — bearer token (optional).
- `UNBROWSE_API_URL` / `UNBROWSE_BASE` — API base (default `https://beta-api.unbrowse.ai`).
- `UNBROWSE_X_PAYMENT` / `X_PAYMENT` — x402 payment header (optional).
- `UNBROWSE_DRYRUN=1` — return synthesized JSON, no network (used by the offline test).

## Scope

Honest scope: this is a thin tool adapter. It wraps three Unbrowse HTTP
endpoints (`/v1/resolve`, `/v1/execute`) using only the Python standard library.
It does not vendor the CrewAI runtime, manage sessions, or perform browser
capture — for capture-based flows use the Unbrowse CLI/MCP. Network calls
require a reachable Unbrowse API; the test suite runs fully offline via
`UNBROWSE_DRYRUN=1`.

MIT licensed.
