# @unbrowse/mastra

Native [Unbrowse](https://unbrowse.ai) tools for [Mastra](https://mastra.ai)
agents. Drop three ready-made tools into any `@mastra/core` agent so it can
resolve an intent to a ranked API shortlist, execute a chosen endpoint, and
search the web — each routed through Unbrowse's resolved-route marketplace cache
(`$0` on a cache hit).

```bash
npm install @unbrowse/mastra
```

## Tools

| tool id            | input (JSON Schema)            | does                                                        |
| ------------------ | ------------------------------ | ----------------------------------------------------------- |
| `unbrowse_resolve` | `{ url, intent }`              | Resolve intent + URL to a ranked shortlist of API endpoints |
| `unbrowse_execute` | `{ endpoint_id, params? }`     | Execute a resolved endpoint and return its body             |
| `unbrowse_search`  | `{ query, url? }`              | Resolve + execute the best route for a search query         |

Each tool uses a plain JSON-Schema `inputSchema` (no zod dependency) and follows
Mastra's `createTool()` runtime shape: `{ id, description, inputSchema, execute }`.
`execute` accepts Mastra's `{ context }` envelope or the args object directly.

## Registration

Register the tools on a Mastra `Agent`. `unbrowseTools` is a record keyed by tool
id, which is exactly the shape `@mastra/core`'s `Agent` expects for `tools`:

```ts
import { Agent } from '@mastra/core/agent';
import { unbrowseTools } from '@unbrowse/mastra';

const agent = new Agent({
  name: 'web',
  instructions: 'Use the Unbrowse tools to resolve, execute, and search.',
  model,
  tools: unbrowseTools,
});
```

If you want tools constructed by Mastra's own `createTool()` (carrying Mastra's
validation/branding), use the factory and pass `createTool` in:

```ts
import { createTool } from '@mastra/core/tools';
import { createUnbrowseTools } from '@unbrowse/mastra';

const tools = createUnbrowseTools({ createTool });
// new Agent({ ..., tools });
```

You can also import each tool individually: `unbrowse_resolve`,
`unbrowse_execute`, `unbrowse_search`.

## Configuration

| env var               | default                        | purpose                                  |
| --------------------- | ------------------------------ | ---------------------------------------- |
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | `https://beta-api.unbrowse.ai` | Unbrowse API base               |
| `UNBROWSE_API_KEY`    | —                              | Bearer token (optional)                  |
| `UNBROWSE_X_PAYMENT`  | —                              | x402 payment header (optional)           |
| `UNBROWSE_DRYRUN=1`   | —                              | Offline: synthesize a result, no network |

## Honest scope (v0.1)

- `unbrowse_resolve` and `unbrowse_execute` map directly onto Unbrowse's
  `/v1/resolve` and `/v1/execute`.
- `unbrowse_search` resolves the query against a target URL (defaults to a
  search-engine URL) and executes the top cached route; it is **not** a dedicated
  search index — quality depends on what the marketplace has captured for that
  target. On a miss it returns `{ ok: false, error: 'no_cached_match' }` rather
  than fabricating results.
- This package only wraps Unbrowse's HTTP surface as `@mastra/core` tools; it
  does not bundle or require `@mastra/core` at runtime (the factory takes
  `createTool` as a dependency), so there is no upstream version lock-in.

MIT licensed. `@mastra/core` is the trademark of its respective owners; this is
an independent integration.
