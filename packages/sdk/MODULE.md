# SDK
Owns: typed REST client, wire conversions, public errors and MCP install helpers.
Invariant: execution stays on the hosted service; no website credentials printed. Only mcp-install.ts is source-synced.
Verify: `bun test packages/sdk && bun run typecheck` from repository root.
