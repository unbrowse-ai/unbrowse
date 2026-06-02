# @unbrowse/ai-sdk

Unbrowse's resolve / execute / search capabilities as **Vercel AI SDK** (npm: `ai`) tools.
One import registers three agent **tool** definitions so a model can resolve an intent to a
ranked endpoint shortlist, execute the chosen endpoint, or do both in one shot.

## Install

```sh
npm install @unbrowse/ai-sdk
```

This package has no runtime dependencies and does **not** depend on `ai` or `zod` — each
`inputSchema` is a plain JSON Schema object.

## Register the tools

```ts
import { generateText } from 'ai';
import { unbrowseTools } from '@unbrowse/ai-sdk';

const result = await generateText({
  model,
  prompt: 'What is the current price of BTC?',
  tools: unbrowseTools,
});
```

`unbrowseTools` is a record keyed by tool name:

| tool | input | does |
|---|---|---|
| `unbrowse_resolve` | `{ url, intent }` | ranks cached endpoints for the intent (`/v1/resolve`) |
| `unbrowse_execute` | `{ endpoint_id, params? }` | runs a resolved endpoint (`/v1/execute`) |
| `unbrowse_search`  | `{ query, url? }` | resolve top + execute it, returns synthesized results |

## Branded instances (recommended when `ai` is installed)

The exported tools are valid tool definitions in the AI SDK's runtime shape
(`{ description, inputSchema, execute }`). To get framework-branded instances — so the
SDK's own schema validation and typing apply — pass your real `tool` and `jsonSchema`
helpers from the Vercel AI SDK (npm: `ai`) into `createUnbrowseTools`:

```ts
import { tool, jsonSchema, generateText } from 'ai';
import { createUnbrowseTools } from '@unbrowse/ai-sdk';

const tools = createUnbrowseTools({ tool, jsonSchema });

await generateText({ model, prompt: 'Find the docs for X', tools });
```

## Configuration (env)

| var | default | meaning |
|---|---|---|
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | `https://beta-api.unbrowse.ai` | backend base URL |
| `UNBROWSE_API_KEY` | — | bearer token (optional) |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | — | x402 payment header (optional) |
| `UNBROWSE_DRYRUN=1` | off | deterministic offline stub results, no network |

## Honest scope

These are **tool definitions** in the Vercel AI SDK (npm: `ai`) tool shape — a plain
object `{ description, inputSchema, execute }`. They run as-is. For framework-branded tool
instances, pass your `tool` / `jsonSchema` helpers via `createUnbrowseTools`. The
`unbrowse_search` tool is a convenience wrapper over resolve + execute, not a separate
search index.

MIT.
