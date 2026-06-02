# Integration Surfaces

There are three ways to call Unbrowse from your own software. They are the same runtime behind different front doors.

| Surface | Use it when | Entry point |
|---|---|---|
| **MCP server** | You are wiring an agent host (Claude, Cursor, Codex, any MCP client) | `npx unbrowse mcp` |
| **`@unbrowse/client`** | You are writing browser, edge, or Node TypeScript/JavaScript | `npm install @unbrowse/client` |
| **`@unbrowse/sdk`** | You need the legacy local-runtime/binary-spawn path | `npm install @unbrowse/sdk` |
| **CLI** | Shell scripts, CI, one-off use | `npx unbrowse` |

MCP and CLI speak to the same local runtime. `@unbrowse/client` calls the hosted API directly; `@unbrowse/sdk` speaks to the local runtime at `http://localhost:6969`.

MCP and the SDKs are the supported integration surfaces; the CLI is the same runtime for direct use.

Both SDK packages are MIT licensed. New code should start with `@unbrowse/client`; use `@unbrowse/sdk` only when you need a local browser session owned by your process. See [SDK Quickstart](./sdk-quickstart.md) and the SDK reference under `sdk/`.

## Already using another library?

If your code already calls `axios`, `got`, `ky`, `undici`, `superagent`, `wretch`,
`node-fetch`, `cross-fetch`, `playwright`, `puppeteer`, `selenium-webdriver`,
`@browserbasehq/stagehand`, `@mendable/firecrawl-js`, `exa-js`, or `@tavily/core`,
you do not need to rewrite it — swap one import for the matching `@unbrowse/*` drop-in.
See [Drop-in Adapters](./drop-in-adapters.md) for the full list and one-line swaps.

## Building an agent?

Unbrowse plugs into the popular agent SDKs as a **native tool** — Vercel AI SDK,
LangChain JS, Mastra, LlamaIndex, and the OpenAI Agents SDK — and serves the full
tool set over MCP (`npx unbrowse mcp`) for any MCP host. See
[Agent SDK Adapters](./agent-sdk-adapters.md).

## Writing Python?

The same drop-in story holds for the Python layer: `requests`, `httpx`, `aiohttp`,
and `urllib3` HTTP clients, plus `crewai` and `pydantic-ai` agent tools. See
[Python Adapters](./python-adapters.md).
