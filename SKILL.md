---
name: unbrowse
description: Capture once, replay everywhere — Unbrowse turns websites into reusable API routes for agents. Resolve an intent + URL to a ranked endpoint shortlist, execute the chosen one for real data, or open a managed browser when capture is needed. Available as an MCP server, CLI, and SDK.
metadata:
  type: integration
  origin: unbrowse-ai/unbrowse
---

# Unbrowse

Unbrowse turns websites into reusable API routes for agents. Teach a route once, store sanitized metadata, replay it on later calls — typically 30× faster and 90× cheaper than a fresh browser session (peer-reviewed benchmark across 94 live domains: 3.6× mean speedup, 40× fewer tokens — [arXiv:2604.00694](https://arxiv.org/abs/2604.00694)).

This skill installs the instructions. The runtime (CLI binary + MCP server) comes from the `unbrowse` npm package — get it with `npx -y unbrowse`.

## Surfaces

| Surface | Reach for it when |
|---|---|
| **MCP server** | An MCP-host agent (Claude Code, Claude Desktop, Cursor, Codex, Windsurf). Tools like `unbrowse_resolve`, `unbrowse_execute`, `unbrowse_go` appear in the host. |
| **CLI** (`unbrowse`) | A shell or script that wants the same surface without an MCP host. |
| **SDK** (`unbrowse/sdk`) | A TypeScript program embedding Unbrowse; the SDK spawns its own local binary. |

## The workflow

Two tools, never one and never three:

- **resolve** — "is there an indexed route for this intent + URL?" Returns a ranked shortlist, or a hard handoff to a browser session.
- **execute** — pick one endpoint from the shortlist and run it. Returns the real data.
- **browse-session** — when the API is too dynamic to predict, open a managed browser; local capture indexes the route metadata for next time.

## Quickstart

Wire the MCP server into an MCP host:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse", "mcp"]
    }
  }
}
```

Then once:

```bash
npx unbrowse setup
```

From a shell:

```bash
unbrowse resolve --intent "search hacker news for openai" --url https://news.ycombinator.com
unbrowse execute --skill-id <id-from-resolve> --endpoint-id <id-from-shortlist>
```

From Node:

```bash
npm i unbrowse
```

```typescript
import { Unbrowse } from 'unbrowse/sdk';
const client = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });
const resolved = await client.resolve({ intent: 'search hn for openai', url: 'https://news.ycombinator.com' });
const result = await client.execute({ endpoint_id: resolved.available_operations![0].endpoint_id, params: { q: 'agents' } });
```

## Passive parallel indexing

While you browse, Unbrowse reverse-engineers the page's API traffic and indexes
it to publish — in the background, in parallel, so browsing stays fast. This is
**on by default**; each `sync` checkpoint returns immediately instead of blocking
on the page's network settle. Opt out per machine to index inline (slower
checkpoints, complete endpoints before each returns):

```bash
unbrowse settings --passive-index off    # opt out; back on with: --passive-index on
```

Agents can toggle the same flag via the `unbrowse_settings` tool
(`passive_index: true|false`).

## Links

- npm: <https://www.npmjs.com/package/unbrowse>
- Docs: <https://www.unbrowse.ai>
- Source: <https://github.com/unbrowse-ai/unbrowse>
