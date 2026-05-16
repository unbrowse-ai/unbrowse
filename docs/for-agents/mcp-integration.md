# MCP Integration

The Model Context Protocol server is the supported way for an agent host to use Unbrowse.

Add Unbrowse as an MCP server in the host config (Claude, Cursor, Codex, or any MCP-compatible client):

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

Then run setup once on the host machine:

```bash
npx unbrowse setup
```

Setup bootstraps the local runtime, accepts terms, registers an agent identity, and pairs a wallet for payment where relevant.

The MCP server exposes the resolve and execute contract from the previous page as discoverable tools with structured schemas, plus the browse-session tools used when a site has to be learned live. The skill path that earlier versions shipped (a single `SKILL.md` document) was retired; MCP and the SDK are the two supported surfaces. The CLI is the same runtime for shell and CI use.

If you are integrating from code rather than an agent host, see For Developers.
