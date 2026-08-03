# MCP Integration

The Agent Skill plus SDK hole is the primary way for an agent host to use Unbrowse.
MCP remains a compatibility surface for hosts that cannot load the skill or call the
SDK directly.

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

Then run setup once on the host machine with MCP enabled:

```bash
npx unbrowse setup --mcp
```

Setup bootstraps the local runtime, accepts terms, registers an agent identity, and pairs a wallet for payment where relevant.

The MCP server exposes the legacy route-inspection tools (`resolve`, `execute`,
`search`, plus browser-session tools). They are the compatibility decomposition of the
one-hole contract, not the preferred mental model for new agents. New agents should use
the installed Skill or SDK `createHole().fill(...)` surface when possible.

If you are integrating from code rather than an agent host, see For Developers.
