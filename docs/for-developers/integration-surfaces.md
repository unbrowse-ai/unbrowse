# Integration Surfaces

There are three ways to call Unbrowse from your own software. They are the same
contract behind different front doors.

| Surface | Use it when | Entry point |
|---|---|---|
| **Agent Skill** | You are wiring a skill-aware agent host | `unbrowse setup` |
| **SDK hole** | You are writing browser, edge, or Node TypeScript/JavaScript | `import { createHole } from "unbrowse/sdk"` |
| **CLI** | Shell scripts, CI, one-off use, contract inspection | `unbrowse contract surface` |
| **MCP server** | Legacy host compatibility | `unbrowse setup --mcp` / `npx unbrowse mcp` |

The preferred contract is the same everywhere: fill one hole. The caller supplies
intent plus optional URL/params/approval; the runtime chooses whether the right
descent is a direct document fetch, shared route graph hit, standard adapter, local
auth/cookies, browser capture, HAR inspection, or newly indexed contract.

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const r = await hole.fill({
  intent: "latest issues in this repository",
  url: "https://github.com/unbrowse-ai/unbrowse/issues",
});
```

## Already Using Another Library?

If your code already calls `axios`, `got`, `ky`, `undici`, `superagent`, `wretch`,
`node-fetch`, `cross-fetch`, `playwright`, `puppeteer`, `selenium-webdriver`,
`@browserbasehq/stagehand`, `@mendable/firecrawl-js`, `exa-js`, or `@tavily/core`,
you do not need to rewrite it. Swap one import for the matching Unbrowse drop-in.
See [Drop-in Adapters](./drop-in-adapters.md).

## Building an Agent?

Start with the installed Agent Skill or the SDK hole. Older framework adapters and
MCP tools may expose `resolve`/`execute`; those are compatibility route-inspection
tools, not the default mental model for new agents.

See [Agent SDK Adapters](./agent-sdk-adapters.md).

## Writing Python?

The same drop-in story holds for the Python layer: `requests`, `httpx`, `aiohttp`,
and `urllib3` HTTP clients, plus `crewai` and `pydantic-ai` agent tools. See
[Python Adapters](./python-adapters.md).
