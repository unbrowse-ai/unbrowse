# @unbrowse/langchain-js

Unbrowse as native [LangChain JS](https://github.com/langchain-ai/langchainjs) tools.

This is the **JavaScript / TypeScript adapter** for `@langchain/core` (a separate Python
package, `unbrowse-langchain`, exists for the Python ecosystem).

It exposes three tools, shaped exactly like LangChain's `StructuredTool` /
`DynamicStructuredTool` runtime surface — `{ name, description, schema, invoke(input), call(input) }`:

| tool              | input                          | does                                                        |
| ----------------- | ------------------------------ | ----------------------------------------------------------- |
| `unbrowse_resolve`| `{ url, intent }`              | resolve an intent + URL to a ranked endpoint shortlist      |
| `unbrowse_execute`| `{ endpoint_id, params? }`     | execute a resolved endpoint                                 |
| `unbrowse_search` | `{ query, url? }`              | resolve + execute, synthesized into ranked results          |

`schema` is a plain **JSON Schema** object, so this package has **no `zod` dependency**.
`invoke` is the modern Runnable method; `call` is the legacy alias — both are provided and
both return a JSON string (LangChain tools return strings).

## Install

```bash
npm install @unbrowse/langchain-js
```

## Use — register with an agent

```ts
import { unbrowseTools } from '@unbrowse/langchain-js';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';

const llm = new ChatOpenAI({ model: 'gpt-4o' });

// Bind Unbrowse's tools straight into the agent's tools array:
const agent = createReactAgent({ llm, tools: unbrowseTools });

const out = await agent.invoke({
  messages: [{ role: 'user', content: 'Find the latest docs on x402 and summarize.' }],
});
```

You can also call a single tool directly:

```ts
import { unbrowseSearchTool } from '@unbrowse/langchain-js';

const json = await unbrowseSearchTool.invoke({ query: 'x402 payment spec' });
const results = JSON.parse(json);
```

## Branded `DynamicStructuredTool` instances

`unbrowseTools` already **matches LangChain's tool shape** and works wherever a tools array
is accepted. If you want genuine, branded `DynamicStructuredTool` instances (for type
checks, tracing, or strict runtime guards), pass your own `tool` helper from `@langchain/core`:

```ts
import { tool } from '@langchain/core/tools';
import { createUnbrowseTools } from '@unbrowse/langchain-js';

const tools = createUnbrowseTools({ tool }); // 3 real DynamicStructuredTool instances
```

This package does **not** import `@langchain/core` itself — you supply the `tool` helper you
already depend on, keeping this adapter dependency-free.

## Configuration

| env                              | default                          | meaning                                    |
| -------------------------------- | -------------------------------- | ------------------------------------------ |
| `UNBROWSE_API_URL` / `UNBROWSE_BASE` | `https://beta-api.unbrowse.ai` | Unbrowse API base                          |
| `UNBROWSE_API_KEY`               | —                                | Bearer auth                                |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | —                              | x402 payment header                        |
| `UNBROWSE_DRYRUN=1`              | —                                | deterministic offline result, no network   |

## License

MIT
