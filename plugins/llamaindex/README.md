# llama-index-tools-unbrowse

LlamaIndex tools for [Unbrowse](https://unbrowse.ai), a hosted service that turns websites into APIs agents can call.

`UnbrowseToolSpec` gives an agent three tools:

| Tool | What it does |
|---|---|
| `unbrowse_scrape(url)` | Reads one page as clean markdown (main content, title, final URL). Plain HTTP when possible, Unbrowse's cloud browser when the page needs JavaScript. |
| `unbrowse_discover(query)` | Finds site capabilities (learned website APIs) that match a request, with their inputs and health. |
| `unbrowse_run(task, capability, input)` | Runs a web task by plain-language `task` or by `capability` id plus `input`, and returns structured JSON. |

## Install

```bash
pip install -U llama-index-tools-unbrowse
export UNBROWSE_API_KEY=...   # free key at https://unbrowse.ai/app
```

## Use

```python
from llama_index.tools.unbrowse import UnbrowseToolSpec

spec = UnbrowseToolSpec()
print(spec.unbrowse_scrape("https://example.com"))
```

With an agent:

```python
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.llms.openai import OpenAI
from llama_index.tools.unbrowse import UnbrowseToolSpec

agent = FunctionAgent(tools=UnbrowseToolSpec().to_tool_list(), llm=OpenAI(model="gpt-4.1"))
print(await agent.run("What are the top 3 stories on Hacker News right now?"))
```

### Run results

`unbrowse_run` returns JSON with a `status`:

- `succeeded`: the data is in `result`.
- `input_required`: the run names what is missing; call again with `input`.
- `no_capability`: nothing fits the task; read the page with `unbrowse_scrape`.

### Options

`UnbrowseToolSpec(api_key=None, url=None, only_main_content=True, render="auto", max_chars=None, timeout=None, raise_errors=False)`

- `api_key`: defaults to `UNBROWSE_API_KEY`.
- `url`: defaults to `UNBROWSE_MCP_URL` or `https://unbrowse.ai/api/mcp`.
- `render`: `"always"` forces the cloud browser, `"never"` plain HTTP only.
- `max_chars`: cut long pages.
- `raise_errors`: by default an Unbrowse error goes back to the agent as `Error: ...`; set `True` to raise `UnbrowseError`.

## Remote MCP instead

Unbrowse is also a remote MCP server, so every Unbrowse tool (browse sessions, credentials, replays and more) is
available through [`llama-index-tools-mcp`](https://pypi.org/project/llama-index-tools-mcp/):

```python
import os
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

client = BasicMCPClient(
    "https://unbrowse.ai/api/mcp",
    headers={"Authorization": f"Bearer {os.environ['UNBROWSE_API_KEY']}"},
)
tools = await McpToolSpec(client=client).to_tool_list_async()
```

With an API key use `https://unbrowse.ai/api/mcp`; `https://unbrowse.ai/mcp` is for OAuth clients. The MCP tool names
contain dots (`unbrowse.scrape`), which some model APIs reject in function names; the tools in this package use
underscores.

## How it works

Each tool call is one JSON-RPC `tools/call` POST to `https://unbrowse.ai/api/mcp` with the key as a bearer
token. The package depends only on `llama-index-core`; HTTP uses the standard library. The key never appears in
errors or results.

## Develop

```bash
pip install -e '.[test]'
pytest                                          # mocked HTTP
UNBROWSE_LIVE=1 UNBROWSE_API_KEY=... pytest     # adds a live call
```

MIT licensed. Source: [unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse/tree/main/plugins/llamaindex).
