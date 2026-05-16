# Integration Surfaces

There are three ways to call Unbrowse from your own software. They are the same runtime behind different front doors.

| Surface | Use it when | Entry point |
|---|---|---|
| **MCP server** | You are wiring an agent host (Claude, Cursor, Codex, any MCP client) | `npx unbrowse mcp` |
| **`@unbrowse/sdk`** | You are writing TypeScript or JavaScript | `npm install @unbrowse/sdk` |
| **CLI** | Shell scripts, CI, one-off use | `npx unbrowse` |

All three speak to the same local runtime. The runtime defaults to `http://localhost:6969`.

The earlier skill path (a single `SKILL.md` shipped through the repo) was retired. MCP and the SDK are the supported integration surfaces; the CLI is the same runtime for direct use.

The SDK is MIT licensed and is the path most code should take. It auto-spawns the runtime if one is not already listening, so a single call takes you from install to first resolve. See [SDK Quickstart](./sdk-quickstart.md) and the SDK reference under `sdk/`.
