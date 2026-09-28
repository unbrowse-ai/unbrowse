# langchain-unbrowse

LangChain tools for [Unbrowse](https://unbrowse.ai), a hosted service that turns websites into APIs agents can call.

| Tool | Name the model sees | What it does |
|---|---|---|
| `UnbrowseScrapeTool` | `unbrowse_scrape` | Reads one page as clean markdown (main content, title, final URL). Plain HTTP when possible, Unbrowse's cloud browser when the page needs JavaScript. |
| `UnbrowseDiscoverTool` | `unbrowse_discover` | Finds site capabilities (learned website APIs) that match a request, with their inputs and health. |
| `UnbrowseRunTool` | `unbrowse_run` | Runs a web task by plain-language `task` or by `capability` id plus `input`, and returns structured JSON. |
| `UnbrowseToolkit` | | All three tools with one API key. |

## Install

```bash
pip install -U langchain-unbrowse
export UNBROWSE_API_KEY=...   # free key at https://unbrowse.ai/app
```

## Use

```python
from langchain_unbrowse import UnbrowseScrapeTool

print(UnbrowseScrapeTool().invoke({"url": "https://example.com"}))
```

```text
Title: Example Domain
URL: https://example.com/

# Example Domain
...
```

With an agent:

```python
from langchain.agents import create_agent
from langchain_unbrowse import UnbrowseToolkit

agent = create_agent("anthropic:claude-sonnet-4-5", tools=UnbrowseToolkit().get_tools())
agent.invoke({"messages": [{"role": "user", "content": "What are the top 3 stories on Hacker News right now?"}]})
```

### Run results

`unbrowse_run` returns JSON with a `status`:

- `succeeded`: the data is in `result`.
- `input_required`: the run names what is missing; call again with `input`.
- `no_capability`: nothing fits the task; read the page with `unbrowse_scrape`.

`input_required` and `no_capability` are normal answers, not errors.

### Options

| Option | Tools | Default | |
|---|---|---|---|
| `api_key` | all | `UNBROWSE_API_KEY` | |
| `url` | all | `UNBROWSE_MCP_URL` or `https://unbrowse.ai/api/mcp` | |
| `timeout` | all | 120 s (discover 60, run 240) | |
| `handle_tool_error` | all | `True` | Unbrowse errors go back to the model as the tool result. Set `False` to raise `ToolException`. |
| `only_main_content` | scrape | `True` | Drop navigation, headers, footers. |
| `render` | scrape | `"auto"` | `"always"` forces the cloud browser, `"never"` plain HTTP only. |
| `max_chars` | scrape | `None` | Cut long pages. |

## Remote MCP instead

Unbrowse is also a remote MCP server, so every Unbrowse tool (browse sessions, credentials, replays and more) is
available through [`langchain-mcp-adapters`](https://github.com/langchain-ai/langchain-mcp-adapters):

```python
import os
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient(
    {
        "unbrowse": {
            "transport": "streamable_http",
            "url": "https://unbrowse.ai/api/mcp",
            "headers": {"Authorization": f"Bearer {os.environ['UNBROWSE_API_KEY']}"},
        }
    }
)
tools = await client.get_tools()
```

With an API key use `https://unbrowse.ai/api/mcp`; `https://unbrowse.ai/mcp` is for OAuth clients. The MCP tool names
contain dots (`unbrowse.scrape`), which some model APIs reject in function names; the tools in this package use
underscores.

## How it works

Each tool call is one JSON-RPC `tools/call` POST to `https://unbrowse.ai/api/mcp` with the key as a bearer
token. The package depends only on `langchain-core`; HTTP uses the standard library. The key is never included in
errors, results or serialized tools.

## Develop

```bash
pip install -e '.[test]'
pytest                                          # mocked HTTP + LangChain standard tool tests
UNBROWSE_LIVE=1 UNBROWSE_API_KEY=... pytest     # adds a live call
```

MIT licensed. Source: [unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse/tree/main/plugins/langchain).
