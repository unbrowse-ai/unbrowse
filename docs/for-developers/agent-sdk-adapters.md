# Agent SDK Adapters

Building an agent? Unbrowse plugs into your framework as a **native tool**. Each
adapter exposes the same three capabilities — `unbrowse_resolve` (intent + URL → a
ranked endpoint shortlist), `unbrowse_execute` (run the chosen endpoint), and
`unbrowse_search` (query → results) — in your framework's own tool type, so you
register Unbrowse with one import instead of hand-writing an HTTP tool.

The frameworks below were chosen by adoption (June 2026): the Vercel AI SDK is the
most-downloaded TypeScript AI toolkit, LangChain has the largest integration
ecosystem, Mastra is built on the AI SDK, LlamaIndex leads RAG, and the OpenAI
Agents SDK is the OpenAI-first standard. Each adapter ships a parity test proving it
provides the framework's tool contract (`scripts/agent-sdk-parity-gate.sh`).

Configure once (optional): `UNBROWSE_API_URL`, `UNBROWSE_API_KEY`,
`UNBROWSE_X_PAYMENT`. Set `UNBROWSE_DRYRUN=1` for offline, deterministic tool calls.

| Framework | Adapter | Tool type |
|---|---|---|
| Vercel AI SDK (npm `ai`) | `@unbrowse/ai-sdk` | `tool({ description, inputSchema, execute })` |
| LangChain JS (`@langchain/core`) | `@unbrowse/langchain-js` | `DynamicStructuredTool` (`name`/`description`/`schema`/`invoke`) |
| Mastra (`@mastra/core`) | `@unbrowse/mastra` | `createTool({ id, description, inputSchema, execute })` |
| LlamaIndex TS (`llamaindex`) | `@unbrowse/llamaindex` | `FunctionTool` (`metadata` + `call`) |
| OpenAI Agents SDK (`@openai/agents`) | `@unbrowse/openai-agents` | `tool({ name, description, parameters, execute })` |

## Vercel AI SDK

```ts
import { generateText } from 'ai';
import { unbrowseTools } from '@unbrowse/ai-sdk';

const { text } = await generateText({
  model,
  tools: unbrowseTools,            // unbrowse_resolve / unbrowse_execute / unbrowse_search
  prompt: 'Find the cheapest flight from SFO to NYC',
});
```

For branded AI SDK tool instances, pass the SDK's own helpers:
`createUnbrowseTools({ tool, jsonSchema })`.

## LangChain JS

```ts
import { unbrowseTools } from '@unbrowse/langchain-js';
// bind to any LangChain agent's tools array; or createUnbrowseTools({ tool }) for
// real DynamicStructuredTool instances. (A separate Python `unbrowse-langchain` exists.)
```

## Mastra

```ts
import { Agent } from '@mastra/core/agent';
import { unbrowseTools } from '@unbrowse/mastra';

const agent = new Agent({ name: 'researcher', model, tools: unbrowseTools });
```

## LlamaIndex TS

```ts
import { agent } from '@llamaindex/workflow';
import { unbrowseTools } from '@unbrowse/llamaindex';

const researcher = agent({ tools: unbrowseTools, llm });
```

## OpenAI Agents SDK

```ts
import { Agent } from '@openai/agents';
import { unbrowseTools } from '@unbrowse/openai-agents';

const agent = new Agent({ name: 'researcher', tools: unbrowseTools });
```

## MCP — the native protocol surface

Unbrowse is itself an **MCP server**, so any MCP-capable host gets the full tool set
with no adapter package at all. Run it directly:

```bash
npx unbrowse mcp
```

It registers into the common hosts out of the box — Claude Desktop, Cursor, Codex,
Continue, and Windsurf (`unbrowse setup` wires the host config). MCP is the
recommended surface for agent hosts; the framework adapters above are for when you
are building an agent **in code** with one of the SDKs rather than wiring a host.

## Honest scope

Each adapter provides Unbrowse's capabilities in the framework's **tool contract**
without bundling the framework itself — import the adapter alongside your existing
framework install. Where you want framework-branded tool instances (so the runtime's
type guards and schema coercion apply), call `createUnbrowseTools({ ... })` and pass
the framework's own `tool` / `createTool` / `FunctionTool` / `jsonSchema` helpers.
The tool handlers route through `/v1/resolve` + `/v1/execute`; behaviour is identical
across frameworks because the backend is the same.

See also [Drop-in Adapters](./drop-in-adapters.md) for zero-edit library
replacements (HTTP clients, browser automation, search) and
[Integration Surfaces](./integration-surfaces.md).
