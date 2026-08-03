# @unbrowse/llamaindex

Unbrowse as native [LlamaIndex TS](https://github.com/run-llama/LlamaIndexTS) **tools**. Drop three agent-callable tools into any `llamaindex` agent so it can resolve and execute live API routes from Unbrowse's marketplace cache.

```bash
npm install @unbrowse/llamaindex
```

## Register the tools

`unbrowseTools` is an array of `FunctionTool`-shaped objects — register it directly with an `agent`:

```ts
import { unbrowseTools } from '@unbrowse/llamaindex';
import { agent } from '@llamaindex/workflow';
import { openai } from '@llamaindex/openai';

const myAgent = agent({
  llm: openai({ model: 'gpt-4o-mini' }),
  tools: unbrowseTools,
});

const res = await myAgent.run('Find the trending products on example.com');
console.log(res.data.result);
```

### Real FunctionTool instances

If you want first-class `FunctionTool` objects from your installed `llamaindex`, inject the class:

```ts
import { FunctionTool } from 'llamaindex';
import { createUnbrowseTools } from '@unbrowse/llamaindex';

const tools = createUnbrowseTools({ FunctionTool }); // FunctionTool.from(fn, metadata) under the hood
const myAgent = agent({ tools });
```

You can also import each tool individually:

```ts
import { unbrowseResolveTool, unbrowseExecuteTool, unbrowseSearchTool } from '@unbrowse/llamaindex';
```

## The three tools

| Tool | Input | What it does |
|------|-------|--------------|
| `unbrowse_resolve` | `{ url, intent }` | Rank callable API endpoints for an intent against a URL |
| `unbrowse_execute` | `{ endpoint_id, params? }` | Execute a resolved endpoint, return the live body |
| `unbrowse_search`  | `{ query, url? }` | One-shot resolve + execute the top endpoint for a query |

Each tool's `call` returns a JSON string (what an LLM tool loop expects).

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | `https://beta-api.unbrowse.ai` | Backend base URL |
| `UNBROWSE_API_KEY` | — | Bearer auth (optional) |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | — | x402 payment header (optional) |
| `UNBROWSE_DRYRUN` | — | Set to `1` for a deterministic offline synthesized result (no network) — used in tests |

## Honest scope

This is a thin **tool** adapter, not a LlamaIndex retriever or vector index. It exposes Unbrowse's `resolve` and `execute` operations as agent tools; it does not embed documents, manage a vector store, or implement LlamaIndex's `BaseRetriever`/`QueryEngine` interfaces. `unbrowse_search` is a convenience that resolves then executes the top-ranked endpoint — it depends on a route existing in the marketplace for the given URL/query, and returns an explicit `ok: false` when none resolves. Quality of results is bounded by what Unbrowse has indexed for the target site.

MIT licensed. See [unbrowse.ai/vs/llamaindex](https://unbrowse.ai/vs/llamaindex).
