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
| **SDK** (`@unbrowse/sdk`) | A TypeScript program embedding Unbrowse; the SDK spawns its own local binary. |

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
npm i @unbrowse/sdk
```

```typescript
import { spawn } from '@unbrowse/sdk';
const client = await spawn();
const resolved = await client.resolve({ intent: 'search hn for openai', url: 'https://news.ycombinator.com' });
const result = await client.execute({ skillId: resolved.skill.id, endpointId: resolved.endpoints[0].id });
```

## Links

- npm: <https://www.npmjs.com/package/unbrowse>
- Docs: <https://www.unbrowse.ai>
- Source: <https://github.com/unbrowse-ai/unbrowse>
