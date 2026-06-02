# @unbrowse/openai-agents

Unbrowse tools for the [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) (`@openai/agents`).

Drop three Unbrowse `tool`s into any `Agent` so it can resolve an intent to a
ranked API shortlist, execute a resolved endpoint, or do both in one shot — every
call routed through Unbrowse's resolved-route marketplace cache.

## Install

```bash
npm install @openai/agents @unbrowse/openai-agents
```

## Register

```ts
import { Agent } from '@openai/agents';
import { unbrowseTools } from '@unbrowse/openai-agents';

const agent = new Agent({
  name: 'web-agent',
  instructions: 'Use the unbrowse tools to fetch live data from the web.',
  tools: unbrowseTools, // resolve, execute, search
});
```

`unbrowseTools` is a plain array of tool objects in the OpenAI Agents SDK runtime
shape (`{ name, description, parameters, execute }`), which the SDK accepts
directly. If you want real `tool()` instances built by the SDK itself, use the
factory and pass in the SDK's `tool`:

```ts
import { tool } from '@openai/agents';
import { createUnbrowseTools } from '@unbrowse/openai-agents';

const tools = createUnbrowseTools({ tool });
const agent = new Agent({ name: 'web-agent', tools });
```

You can also import each tool individually:

```ts
import {
  unbrowseResolveTool,
  unbrowseExecuteTool,
  unbrowseSearchTool,
} from '@unbrowse/openai-agents';
```

## Tools

| tool              | args                          | does                                                            |
| ----------------- | ----------------------------- | --------------------------------------------------------------- |
| `unbrowse_resolve` | `{ url, intent }`             | Ranked shortlist of cached endpoints for an intent + URL.       |
| `unbrowse_execute` | `{ endpoint_id, params? }`    | Run a resolved endpoint by id, returning its result body.       |
| `unbrowse_search`  | `{ query, url? }`             | Resolve a query and execute the top hit in one shot.            |

Each tool's `execute(args)` resolves to a **string** (JSON-stringified result),
which the SDK feeds back to the model as the tool output.

## Configuration

| env                 | meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `UNBROWSE_API_URL`  | API base (falls back to `UNBROWSE_BASE`, then the default).   |
| `UNBROWSE_BASE`     | Alternate API base.                                           |
| `UNBROWSE_API_KEY`  | Bearer token sent as `authorization`.                         |
| `UNBROWSE_X_PAYMENT`| x402 payment header (`x-payment`); `X_PAYMENT` also accepted. |
| `UNBROWSE_DRYRUN`   | `1` → deterministic offline synthesized result, no network.   |

## Honest scope

v0.1 wraps the public `resolve` + `execute` marketplace surface only. A cache
miss returns `{ ok: false, error: "no_cached_match" }` — there is no automatic
browse-and-capture fallback in this adapter; capture a route first via the
Unbrowse CLI/MCP, then these tools can serve it. `unbrowse_search` is a thin
resolve→execute-top-hit convenience, not a full web search index.

Attribution: targets the public runtime tool shape of `@openai/agents`
(MIT, https://github.com/openai/openai-agents-js). This package depends on
nothing from the SDK; it produces objects the SDK consumes.

MIT.
