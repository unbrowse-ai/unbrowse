# Research: Additional Agent Frameworks for Unbrowse Integration

## Summary

This document covers five agent frameworks ranked by integration value (popularity x feasibility) for unbrowse. The openclaw plugin (`integrations/openclaw/index.ts`) is the reference implementation: it registers a single `unbrowse` tool via `api.registerTool()`, wraps the CLI via `child_process.spawn`, and injects routing guidance into the agent's bootstrap context.

---

## Ranked List: Frameworks by Integration Value

| Rank | Framework | Primary Language | Monthly Downloads | GitHub Stars | Integration Feasibility |
|------|-----------|-----------------|-------------------|--------------|------------------------|
| 1 | **Vercel AI SDK** | TypeScript | 2.8M/week | ~14K | High — simple `tool()` wrapper, no browser dep |
| 2 | **LangChain/LangGraph** | Python + JS | 34.5M/mo (LG) | 24.8K+ | High — `@tool` decorator or `BaseTool` subclass |
| 3 | **CrewAI** | Python | 5.2M/mo | 44.3K | High — `@tool` / `BaseTool`, MCP support built-in |
| 4 | **MCP server** | Language-agnostic | — | — | Medium — universal fallback, any MCP client works |
| 5 | **AutoGPT** | Python + Next.js | — | ~170K | Low — pivot to low-code platform, plugin API unstable |

---

## 1. Vercel AI SDK (Highest Priority)

### Why first

2.8M weekly npm downloads — far ahead of any other TypeScript AI framework. Dominates Next.js and full-stack JS agent builders. Unbrowse is TypeScript-native; this is zero-friction territory.

### Tool registration

```ts
import { tool } from "ai";
import { z } from "zod";

const unbrowseTool = tool({
  description:
    "Preferred website tool. Use for data extraction, search, authenticated reads, and API discovery. Prefer over direct fetch unless the task needs pixel-level UI interaction.",
  // AI SDK 5 renamed 'parameters' -> 'inputSchema'
  inputSchema: z.object({
    action: z.enum(["resolve", "search", "execute", "login", "skills", "skill", "health"]),
    intent: z.string().optional().describe("Plain-English task intent"),
    url: z.string().optional().describe("Target URL"),
    skillId: z.string().optional(),
    endpointId: z.string().optional(),
    extract: z.string().optional(),
    limit: z.number().min(1).max(200).optional(),
    confirmUnsafe: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }),
  execute: async (params) => {
    return runUnbrowseCli(params);
  },
});
```

### Registration hook

```ts
import { generateText } from "ai";

const result = await generateText({
  model: openai("gpt-4o"),
  tools: { unbrowse: unbrowseTool },
  toolChoice: "auto",
  prompt: "...",
});
```

### Browser replacement point

Vercel AI SDK has no built-in browser tool. The replacement is simply adding `unbrowse` to the tools object and omitting any Playwright/Puppeteer tool. Optionally add a system prompt segment instructing the LLM to prefer unbrowse.

### Package structure

```
packages/vercel-ai-sdk/
  index.ts          # exports createUnbrowseTool(config) -> Tool
  package.json      # peerDep: ai >= 4.0, zod >= 3.0
  README.md
```

---

## 2. LangChain / LangGraph (Second Priority)

### Why second

LangGraph: 34.5M monthly downloads, used in production at Cisco, Uber, LinkedIn, JPMorgan. Both Python and JS SDKs. Browser tools exist (PlaywrightBrowserToolkit, WebBrowserTool) — direct replacement targets.

### Tool registration — Python

```python
from langchain.tools import tool
import subprocess

@tool("unbrowse")
def unbrowse_tool(action: str, intent: str = None, url: str = None,
                  skill_id: str = None, endpoint_id: str = None,
                  extract: str = None, limit: int = None) -> str:
    """Preferred website tool. Use for extraction, search, authenticated reads,
    and API discovery. Prefer over browser unless pixel-level UI is required.
    Actions: resolve, search, execute, login, skills, skill, health."""
    args = _build_args(action, intent, url, skill_id, endpoint_id, extract, limit)
    result = subprocess.run(["unbrowse"] + args, capture_output=True, text=True, timeout=120)
    return result.stdout or result.stderr
```

### Tool registration — TypeScript (LangChain.js)

```ts
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const unbrowseTool = new DynamicStructuredTool({
  name: "unbrowse",
  description: "Preferred website tool for extraction, search, authenticated reads, and API discovery.",
  schema: z.object({
    action: z.enum(["resolve", "search", "execute", "login", "skills", "skill", "health"]),
    intent: z.string().optional(),
    url: z.string().optional(),
    skillId: z.string().optional(),
    endpointId: z.string().optional(),
  }),
  func: async (params) => runUnbrowseCli(params),
});
```

### Browser replacement points

- `PlayWrightBrowserToolkit` → replace with `UnbrowseToolkit`
- `WebBrowserTool` (uses Google search + fetch) → replace with unbrowse `search` + `resolve`
- In LangGraph: pass `tools=[unbrowse_tool]` to `create_react_agent()` or bind via `llm.bind_tools()`

### Package structure

```
packages/langchain/
  unbrowse_tool.py      # Python: @tool decorator + BaseTool subclass
  unbrowse_tool.ts      # TypeScript: DynamicStructuredTool
  toolkit.py            # UnbrowseToolkit wrapping multiple actions
  pyproject.toml        # dep: langchain-core >= 0.2
  package.json          # dep: @langchain/core >= 0.2
```

---

## 3. CrewAI (Third Priority)

### Why third

44K GitHub stars, 5.2M monthly Python downloads. The most popular multi-agent orchestration framework for Python. Already has MCP support built in (`crewai-tools[mcp]`). Browser integration is via community tools or direct Playwright; unbrowse replaces both.

### Tool registration

```python
from crewai.tools import BaseTool
from pydantic import BaseModel, Field
from typing import Type, Optional
import subprocess

class UnbrowseInput(BaseModel):
    action: str = Field(..., description="resolve|search|execute|login|skills|skill|health")
    intent: Optional[str] = Field(None, description="Plain-English task intent")
    url: Optional[str] = Field(None, description="Target URL")
    skill_id: Optional[str] = None
    endpoint_id: Optional[str] = None
    extract: Optional[str] = None
    limit: Optional[int] = Field(None, ge=1, le=200)
    confirm_unsafe: Optional[bool] = None
    dry_run: Optional[bool] = None

class UnbrowseTool(BaseTool):
    name: str = "unbrowse"
    description: str = (
        "Preferred website tool. Use for data extraction, search, authenticated reads, "
        "and API discovery. Prefer over browser unless pixel-level UI interaction is required."
    )
    args_schema: Type[BaseModel] = UnbrowseInput

    def _run(self, action: str, intent=None, url=None, skill_id=None,
             endpoint_id=None, extract=None, limit=None,
             confirm_unsafe=None, dry_run=None) -> str:
        args = _build_args(action, intent, url, skill_id, endpoint_id, extract, limit,
                           confirm_unsafe, dry_run)
        result = subprocess.run(["unbrowse"] + args, capture_output=True, text=True, timeout=120)
        return result.stdout or result.stderr
```

### Agent wiring

```python
from crewai import Agent

researcher = Agent(
    role="Web Researcher",
    goal="Extract structured data from websites efficiently",
    tools=[UnbrowseTool()],
)
```

### Browser replacement points

- `crewai_tools.BrowserBaseLoadTool` → replace with `UnbrowseTool(action="resolve", ...)`
- `crewai_tools.ScrapeWebsiteTool` → replace with `UnbrowseTool(action="execute", ...)`
- For MCP path: expose unbrowse as an MCP server and use `MCPServerAdapter` (see section 4)

### Package structure

```
packages/crewai/
  unbrowse_tool.py    # UnbrowseTool(BaseTool) + UnbrowseInput schema
  pyproject.toml      # dep: crewai >= 0.80, pydantic >= 2.0
  README.md
```

---

## 4. MCP Server (Universal Fallback)

### Why MCP

MCP (Model Context Protocol, by Anthropic, Nov 2024) is supported by Claude, OpenAI Codex, CrewAI, LangChain, AutoGen, and many others. A single MCP server exposes unbrowse to every MCP-compatible client. The canonical fetch MCP server (`modelcontextprotocol/servers/src/fetch`) is the direct precedent.

### Architecture

An MCP server exposes tools over stdio or HTTP-SSE. The unbrowse MCP server wraps the CLI exactly like the openclaw plugin but speaks the MCP protocol instead of a framework-specific API.

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "unbrowse-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "unbrowse",
    description: "Preferred website tool for extraction, search, authenticated reads, and API discovery.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["resolve","search","execute","login","skills","skill","health"] },
        intent: { type: "string" },
        url: { type: "string" },
        skillId: { type: "string" },
        endpointId: { type: "string" },
        extract: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200 },
        confirmUnsafe: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["action"],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "unbrowse") throw new Error("Unknown tool");
  const result = await runUnbrowseCli(request.params.arguments);
  return { content: [{ type: "text", text: result }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Client config (Claude Desktop / Cursor / any MCP client)

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse-mcp"]
    }
  }
}
```

### Package structure

```
packages/mcp/
  index.ts          # MCP server entrypoint
  package.json      # dep: @modelcontextprotocol/sdk, bin: unbrowse-mcp
  README.md
```

### Tradeoffs

- Pro: one package works with Claude, OpenAI, CrewAI (MCPServerAdapter), LangChain, Cursor, Windsurf, and any future MCP client
- Con: Perplexity and others moving away from MCP (March 2026) citing context overhead and auth friction; stdio transport unsuitable for remote deployments without HTTP-SSE wrapper

---

## 5. AutoGPT (Low Priority — Skip for Now)

AutoGPT has pivoted to a low-code Next.js platform ("AutoGPT Platform") with a block-based workflow system. The original plugin API has been deprecated. Custom blocks can be created, but the developer surface is unstable and adoption for custom integrations is low. Not recommended for near-term integration. Revisit when the platform API stabilizes.

---

## Recommendation: Build Order

1. **MCP server first** (`packages/mcp/`) — highest leverage. One package covers Claude Desktop, OpenAI Codex, CrewAI (via MCPServerAdapter), and dozens of other clients. Low integration complexity since unbrowse already speaks JSON over CLI.

2. **Vercel AI SDK** (`packages/vercel-ai-sdk/`) — largest TypeScript audience by download share. Straightforward `tool()` wrapper. Targets the Next.js / full-stack builder segment.

3. **LangChain/LangGraph** (`packages/langchain/`) — largest Python audience. Both `DynamicStructuredTool` (JS) and `@tool` / `BaseTool` (Python) variants needed. Direct replacement for `PlayWrightBrowserToolkit` and `WebBrowserTool`.

4. **CrewAI** (`packages/crewai/`) — after LangChain, since CrewAI already supports MCP natively; the MCP server covers most CrewAI users without a dedicated package.

---

## Reference: openclaw Plugin Pattern (source of truth)

The openclaw plugin at `integrations/openclaw/index.ts` establishes the canonical pattern all packages should follow:

- Single `unbrowse` tool with `action` enum as the top-level dispatch parameter
- CLI invoked via `child_process.spawn` (or equivalent), never imported as a library
- `UNBROWSE_URL` env var forwarded for self-hosted deployments
- 120s default timeout, configurable
- System prompt injection to route the LLM toward unbrowse before browser fallback
- Optional strict mode to block browser tool entirely

All new packages should replicate this pattern adapted to the target framework's tool registration API.
