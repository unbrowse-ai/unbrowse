# @unbrowse/mcp-server

MCP (Model Context Protocol) server for [unbrowse](https://unbrowse.ai) — reverse-engineer any website into reusable API skills.

Works with any MCP-compatible client: Claude Desktop, Cursor, Windsurf, Cline, and others.

## Prerequisites

Install the unbrowse CLI globally:

```bash
npm install -g unbrowse
```

## Setup

### Claude Desktop

Add to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "@unbrowse/mcp-server"]
    }
  }
}
```

Or if installed locally:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "node",
      "args": ["/path/to/integrations/mcp/dist/index.js"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "@unbrowse/mcp-server"]
    }
  }
}
```

### Windsurf / Cline

Same pattern — point the MCP server config to `npx -y @unbrowse/mcp-server`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNBROWSE_BIN` | `unbrowse` | Path to the unbrowse CLI binary |
| `UNBROWSE_TIMEOUT_MS` | `120000` | Command timeout in milliseconds |

## Tools

| Tool | Description |
|------|-------------|
| `unbrowse_resolve` | Reverse-engineer a website URL into API endpoints |
| `unbrowse_search` | Search the marketplace for existing skills |
| `unbrowse_execute` | Execute a skill endpoint with parameters |
| `unbrowse_login` | Open browser for website authentication |
| `unbrowse_skills` | List locally cached skills |
| `unbrowse_skill` | Get details of a specific skill |
| `unbrowse_health` | Check CLI installation and health |

## Development

```bash
cd integrations/mcp
bun install
bun run build
bun test
```
