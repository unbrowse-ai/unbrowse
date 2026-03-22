# Plugin Onboarding UX Research

Research across five agent frameworks: MCP, ElizaOS, LangChain, Vercel AI SDK, and Hermes Agent. For each, the best-performing public repos were analyzed for README structure, install flow, config snippets, and quickstart patterns.

---

## 1. MCP Servers

### Top repos analyzed
- [github/github-mcp-server](https://github.com/github/github-mcp-server) — 16k+ stars, most starred MCP server
- [smithery-ai/mcp-obsidian](https://github.com/smithery-ai/mcp-obsidian) — best example of Smithery.ai listing integration

### README structure (github-mcp-server)

1. Go Report Card badge
2. One-line purpose statement
3. Use Cases (5 bullet points — concrete, verb-led)
4. Remote server option (cloud, zero-setup)
5. Local server option (Docker)
6. Installation per host (VS Code, Claude Desktop, JetBrains, etc.)
7. Tool Configuration (toolsets, individual tools)
8. Additional documentation links

### Installation pattern

Two tiers are always provided — **one-click** and **manual JSON**:

**One-click (VS Code badge):**
```
Install in VS Code  [badge button]
```

**Manual (Claude Desktop `claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
               "ghcr.io/github/github-mcp-server"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>"
      }
    }
  }
}
```

**Smithery one-liner (mcp-obsidian):**
```bash
npx -y @smithery/cli install mcp-obsidian --client claude
```

### Smithery listing pattern

The mcp-obsidian README opens with a Smithery badge linking to its listing page, then shows the Smithery CLI one-liner before the manual JSON. This puts the zero-friction path first.

### Verify-it-works

The github-mcp-server ships a CLI utility:
```bash
github-mcp-server tool-search "<query>"
```
mcp-obsidian uses a screenshot: "restart Claude Desktop and you should see the following MCP tools listed."

### Key patterns
- **Two-tier install**: one-click badge first, JSON fallback second
- **Concrete use cases up front** — not feature lists, but "Repository Management", "Issue & PR Automation"
- **Toolset discovery**: for servers with 20+ tools, document how to enable dynamic toolset discovery to avoid context overload
- **No GIFs** — screenshots of tool list in Claude sidebar are the standard verification artifact

---

## 2. ElizaOS Plugins

### Top repos analyzed
- [elizaos-plugins/client-telegram](https://github.com/elizaos-plugins/client-telegram) — canonical client plugin pattern
- [elizaOS/eliza-plugin-starter](https://github.com/elizaOS/eliza-plugin-starter) — official starter template
- [elizaos.ai plugin development docs](https://docs.elizaos.ai/plugins/development)

### README structure (client-telegram)

1. Migration notice (if applicable)
2. Plugin overview (1 sentence)
3. Features (bullet list)
4. Configuration options (table with Setting / Type / Default / Purpose)
5. Example character.json snippet
6. Settings modification instructions
7. Best Practices
8. Prerequisites
9. Startup commands

### Installation pattern

No `npm install` one-liner — ElizaOS plugins are registered in `character.json` or the agent definition. The install is conceptual:

```json
{
  "clients": ["telegram"],
  "secrets": {
    "key": "<your-bot-token>"
  },
  "allowDirectMessages": true,
  "shouldOnlyJoinInAllowedGroups": true,
  "allowedGroupIds": ["-123456789"]
}
```

For code-based registration (v2 style):
```typescript
import { myPlugin } from '@yourorg/plugin-myplugin';

const agent = {
  name: 'MyAgent',
  plugins: [myPlugin],
};
```

### CLI scaffold quickstart

The elizaOS CLI is the recommended entry point. The docs describe a 3-step pattern: **Scaffold → Build → Test**:
```bash
elizaos create plugin my-plugin   # scaffold
elizaos dev                        # hot-reload development
bun run build && npm publish       # publish
```

### Configuration table pattern

The client-telegram README uses a markdown table for every config option — this is a standout pattern. Each row: Setting | Type | Default | Purpose. This removes ambiguity without requiring the user to read prose.

### Prerequisites section

Always placed after the example config, not before. Pattern:
1. Show what the working config looks like
2. Then explain what you need to obtain (bot token, API key)
3. Where to put it (`.env` + `character.json` secrets)

### Key patterns
- **Config table before prose** — structured table beats a paragraph of option descriptions
- **character.json snippet is the install** — no separate package install step; the plugin IS the config entry
- **CLI scaffolding as the happy path** — docs route all new plugin authors through `elizaos create plugin`
- **No GIFs** — text-only READMEs are the norm in this ecosystem

---

## 3. LangChain Tools

### Top repos analyzed
- [langchain-ai/langchain](https://github.com/langchain-ai/langchain) — main repo (reference for README structure)
- [LangChain Playwright toolkit docs](https://docs.langchain.com/oss/python/integrations/tools/playwright)

### README structure (langchain main)

1. Logo + tagline ("The agent engineering platform")
2. Badges: License, PyPI Downloads, Version, Twitter
3. 1-paragraph intro
4. Quickstart (minimal code block — 3 lines)
5. Tip callout pointing to LangGraph / LangSmith
6. Ecosystem map
7. Why use LangChain? (5 bullet value props)
8. Documentation links
9. Community / contributing

### Installation one-liner

```bash
pip install langchain
```
or `uv add langchain`

### Toolkit pattern (Playwright as example)

LangChain uses the **Toolkit abstraction** — a class that owns a browser instance and produces a list of tools:

```python
from langchain_community.agent_toolkits import PlayWrightBrowserToolkit
from langchain_community.tools.playwright.utils import create_async_playwright_browser

async_browser = create_async_playwright_browser()
toolkit = PlayWrightBrowserToolkit.from_browser(async_browser=async_browser)
tools = toolkit.get_tools()
```

Then pass `tools` directly to the agent:
```python
from langchain_anthropic import ChatAnthropic
from langchain.agents import create_agent

model = ChatAnthropic(model_name="claude-haiku-4-5-20251001", temperature=0)
agent_chain = create_agent(model=model, tools=tools)
result = await agent_chain.ainvoke({"messages": [("user", "Navigate to example.com")]})
```

### Before/after pattern

LangChain integration docs use a two-section structure: **"Without toolkit"** (manual tool construction) vs **"With toolkit"** (one `from_browser` call). This makes the abstraction value immediately visible.

### Key patterns
- **Minimal quickstart**: the main README shows 3 lines of working code, nothing more
- **Toolkit = batteries included**: one object owns the browser, produces the tool list, handles teardown
- **No config files**: pure Python — import, instantiate, pass to agent
- **Documentation trifecta**: link to API reference, narrative docs, and an interactive chat assistant
- **Badge density is high**: PyPI downloads badge signals production adoption immediately

---

## 4. Vercel AI SDK Tools

### Top repos analyzed
- [vercel/ai](https://github.com/vercel/ai) — 22.9k stars, official repo
- [vercel-labs/ai-sdk-tool-as-package-template](https://github.com/vercel-labs/ai-sdk-tool-as-package-template) — canonical third-party tool package pattern

### README structure (vercel/ai)

1. Hero image
2. 1-sentence intro
3. `npm install ai` one-liner
4. Skill for Coding Agents (`npx skills add vercel/ai`)
5. Unified Provider Architecture overview
6. Usage section with 4 sub-patterns:
   - Generating Text
   - Generating Structured Data
   - Agents
   - UI Integration
7. Templates (starter project links)
8. Community / Contributing / Authors

### Tool definition pattern

The canonical pattern from ai-sdk-tool-as-package-template:

**Package author side** — define and export the tool:
```typescript
// src/tools/weather.ts
import { tool } from 'ai';
import { z } from 'zod';

export const getWeather = (options?: { unit?: 'celsius' | 'fahrenheit' }) =>
  tool({
    description: 'Get current weather for a location',
    inputSchema: z.object({
      location: z.string().describe('City name'),
    }),
    execute: async ({ location }) => ({
      location,
      temperature: 22,
      unit: options?.unit ?? 'celsius',
    }),
  });
```

**Consumer side** — install and use:
```bash
npm install my-weather-tool
```
```typescript
import { getWeather } from 'my-weather-tool';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: "What's the weather in SF?",
  tools: { getWeather: getWeather({ unit: 'celsius' }) },
});
```

### Key patterns
- **Factory function pattern**: tools exported as factory functions (`getWeather(options)`) so consumers configure at import time
- **Zod schemas as the interface contract**: the schema IS the documentation — no separate "params" table needed
- **`npx skills add`**: the README actively supports coding-agent onboarding with a skills command
- **No config files, no JSON**: pure TypeScript, type-safe end-to-end
- **Template repo is the canonical starting point**: vercel-labs/ai-sdk-tool-as-package-template serves as the "blessed" structure

---

## 5. Hermes Agent Plugins

### Status

[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) is not a widely deployed open plugin ecosystem as of early 2026. The repo exists but has minimal plugin infrastructure and no established plugin README convention. No standout community plugin repos were found with meaningful onboarding patterns.

**Recommendation**: Skip Hermes as a reference for onboarding UX. The Hermes model family is used as a backend for other frameworks (including ElizaOS and LangChain), but "Hermes Agent plugins" as a distinct distribution format does not have an established pattern worth emulating.

---

## Cross-Framework Recommendations

### What actually works

**1. Two-tier install: zero-config path + manual fallback**

Every successful MCP server README leads with the path that requires zero typing (`npx -y @smithery/cli install X --client claude` or a VS Code badge), then shows the JSON config for users who want control. Never lead with the JSON.

**2. Config snippet as the centerpiece**

The single most-referenced section across all frameworks is the copy-pasteable config block. Make it complete (no `...` placeholders), runnable on first paste, and put it above the fold. ElizaOS and MCP both nail this.

**3. Concrete use cases, not feature lists**

github-mcp-server lists "Repository Management", "Issue & PR Automation", "CI/CD Intelligence" — action phrases that map to user intent. Compare to a feature list ("supports 30+ GitHub API endpoints"). The former passes the "so what?" test.

**4. Config options as a table, not prose**

ElizaOS client-telegram uses a markdown table (Setting | Type | Default | Purpose) for every option. This is faster to scan than a bulleted list of paragraphs and eliminates ambiguity about defaults.

**5. Prerequisites after the example, not before**

Show the working config first. Then explain what credentials to obtain and where to put them. Users pattern-match on the complete example before reading the setup steps.

**6. Verification artifact**

Every framework has a different flavor:
- MCP: screenshot of tool list in Claude sidebar
- ElizaOS: `elizaos dev` log output showing plugin loaded
- LangChain: interactive notebook cell with printed output
- Vercel AI SDK: `pnpm test` passing

Pick one and include it. "Restart and you should see X" with a screenshot beats "verify the integration is working."

**7. Zod/typed schemas replace parameter documentation**

In TypeScript ecosystems (Vercel AI SDK, MCP TypeScript servers), a well-annotated Zod schema is self-documenting. `.describe('The city name')` on each field removes the need for a separate "Parameters" section.

### What to avoid

- Leading with a long features list before showing any code
- Requiring manual JSON edits before offering a one-click path
- Leaving `<your-token-here>` placeholders without explaining where to get the token
- Separate "Installation" and "Configuration" sections that require cross-referencing
- More than one level of nested config objects in the quickstart snippet
