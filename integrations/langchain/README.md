# unbrowse-langchain

LangChain tools for the [Unbrowse](https://unbrowse.ai) CLI — reverse-engineer any website into reusable API skills.

## Installation

```bash
pip install unbrowse-langchain
```

Requires the `unbrowse` CLI to be installed and available on `PATH` (or specify a custom path).

## Quick start

```python
from unbrowse_langchain import create_unbrowse_toolkit

tools = create_unbrowse_toolkit()
```

### With a LangChain agent

```python
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from unbrowse_langchain import create_unbrowse_toolkit

llm = ChatOpenAI(model="gpt-4o")
tools = create_unbrowse_toolkit()
agent = create_react_agent(llm, tools)

result = agent.invoke({
    "messages": [("user", "Find API skills for getting weather data")]
})
```

### Individual tools

```python
from unbrowse_langchain import UnbrowseResolveTool, UnbrowseSearchTool

resolve = UnbrowseResolveTool()
result = resolve.invoke({
    "intent": "get product prices",
    "url": "https://example.com/products",
})

search = UnbrowseSearchTool()
result = search.invoke({"intent": "weather forecast api"})
```

### Custom CLI path

```python
tools = create_unbrowse_toolkit(bin_path="/opt/bin/unbrowse", timeout=60)
```

## Available tools

| Tool | Action | Required args |
|------|--------|---------------|
| `unbrowse_resolve` | Reverse-engineer a page into an API skill | `intent`, `url` |
| `unbrowse_search` | Search the skill marketplace | `intent` |
| `unbrowse_execute` | Execute a skill endpoint | `skill_id`, `endpoint_id` |
| `unbrowse_login` | Authenticate with a site | `url` |
| `unbrowse_skills` | List cached skills | — |
| `unbrowse_skill` | Inspect a skill | `skill_id` |
| `unbrowse_health` | Health check | — |
