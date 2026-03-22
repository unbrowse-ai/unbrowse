# unbrowse-langchain

LangChain tools for [Unbrowse](https://unbrowse.ai) — drop-in replacement for `PlayWrightBrowserToolkit` and `WebBrowserTool` that returns structured JSON instead of raw HTML.

## Bootstrap Unbrowse first

```bash
npx unbrowse setup
unbrowse health
```

## Installation

```bash
npx unbrowse setup
pip install unbrowse-langchain
```

## Quick Start

### Replace PlayWrightBrowserToolkit

Before (unstructured HTML, slow, needs Chromium):
```python
from langchain_community.agent_toolkits import PlayWrightBrowserToolkit
from langchain_community.tools.playwright.utils import create_sync_playwright_browser

browser = create_sync_playwright_browser()
tools = PlayWrightBrowserToolkit.from_browser(browser).get_tools()
```

After (structured JSON, cached, no browser needed):
```python
from unbrowse_langchain import create_unbrowse_toolkit

tools = create_unbrowse_toolkit()
```

### With a ReAct Agent

```python
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from unbrowse_langchain import create_unbrowse_toolkit

llm = ChatOpenAI(model="gpt-4o")
tools = create_unbrowse_toolkit()
agent = create_react_agent(llm, tools)

result = agent.invoke({
    "messages": [("user", "Get the top stories from Hacker News")]
})
```

The agent will call `unbrowse_resolve` with the URL and intent, getting back structured data like:
```json
[
  {"title": "OpenCode", "link": "https://opencode.ai/", "score": "580 points", "rank": "1"},
  {"title": "Molly Guard", "link": "https://...", "score": "38 points", "rank": "2"}
]
```

### With Anthropic

```python
from langchain_anthropic import ChatAnthropic
from langgraph.prebuilt import create_react_agent
from unbrowse_langchain import create_unbrowse_toolkit

llm = ChatAnthropic(model="claude-sonnet-4-20250514")
tools = create_unbrowse_toolkit()
agent = create_react_agent(llm, tools)

result = agent.invoke({
    "messages": [("user", "Get the trending repos on GitHub")]
})
```

### Individual Tools

```python
from unbrowse_langchain import UnbrowseResolveTool, UnbrowseSearchTool

# Resolve a website into structured data
resolve = UnbrowseResolveTool()
result = resolve.invoke({
    "intent": "get top stories",
    "url": "https://news.ycombinator.com",
})
# Returns: [{"title": "...", "link": "...", "score": "..."}, ...]

# Search the skill marketplace
search = UnbrowseSearchTool()
result = search.invoke({"intent": "weather forecast api"})
```

### Custom Configuration

```python
tools = create_unbrowse_toolkit(
    bin_path="/opt/bin/unbrowse",   # custom binary path
    timeout=60,                     # timeout in seconds (default: 120)
)
```

## How It Replaces the Browser

| | PlayWrightBrowserToolkit | unbrowse-langchain |
|---|---|---|
| **Output** | Raw HTML/text, agent must parse | Structured JSON with extracted fields |
| **Speed (first)** | 5-30s per page | 5-15s (discovers + caches API) |
| **Speed (cached)** | Same every time | 300ms-1s |
| **Dependencies** | Chromium, Playwright | unbrowse CLI only |
| **Auth support** | Manual cookie injection | `unbrowse login --url` captures session |
| **Reliability** | Breaks on DOM changes | Uses discovered API endpoints |

## Available Tools

| Tool | Description | Required args |
|------|-------------|---------------|
| `unbrowse_resolve` | Reverse-engineer a page into structured data | `intent`, `url` |
| `unbrowse_search` | Search the skill marketplace | `intent` |
| `unbrowse_execute` | Execute a cached skill endpoint | `skill_id`, `endpoint_id` |
| `unbrowse_login` | Authenticate with a site | `url` |
| `unbrowse_skills` | List cached skills | -- |
| `unbrowse_skill` | Inspect a skill | `skill_id` |
| `unbrowse_health` | Health check | -- |

## Development

```bash
cd integrations/langchain
pip install -e ".[dev]"
pytest tests/   # 14 tests
```
