# Unbrowse MCP Server

Built into the `unbrowse` CLI. No separate package needed.

## Setup

### 1. Install unbrowse

```bash
npx unbrowse setup
unbrowse health
```

### 2. Add to your MCP client

The MCP server starts with `unbrowse mcp`. Point your client at it:

#### Claude Desktop

Open Settings > Developer > Edit Config. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "unbrowse",
      "args": ["mcp"]
    }
  }
}
```

Restart Claude Desktop. You'll see unbrowse tools in the hammer icon.

#### Claude Code

```bash
claude mcp add unbrowse -- unbrowse mcp
```

Or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "unbrowse",
      "args": ["mcp"]
    }
  }
}
```

#### Cursor

Open Settings > MCP > Add new MCP server:
- Name: `unbrowse`
- Type: `command`
- Command: `unbrowse mcp`

Or add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "unbrowse",
      "args": ["mcp"]
    }
  }
}
```

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "unbrowse",
      "args": ["mcp"]
    }
  }
}
```

#### Cline (VS Code)

Open Cline sidebar > MCP Servers > Configure:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "unbrowse",
      "args": ["mcp"]
    }
  }
}
```

### 3. Try it

Ask your agent: *"Get me the top stories from Hacker News"*

It will call `unbrowse_resolve` and return structured JSON — titles, links, scores, authors — instead of raw HTML.

## What Happens

| | Without unbrowse | With unbrowse |
|---|---|---|
| Agent asks for web data | Opens browser, navigates, scrapes HTML | Calls `unbrowse_resolve`, gets structured JSON |
| Response format | Raw text, agent must parse | Clean JSON with extracted fields |
| First request | 5-30s | 5-15s (discovers API, caches as skill) |
| Repeat requests | Same speed every time | 300ms-1s (cached skill) |
| Auth sites | Manual cookie injection | `unbrowse_login` captures session |

## Tools

| Tool | Description |
|------|-------------|
| `unbrowse_resolve` | Give a URL + intent, get structured data back |
| `unbrowse_search` | Find pre-built skills in the marketplace |
| `unbrowse_execute` | Re-run a cached skill endpoint (sub-second) |
| `unbrowse_login` | Authenticate so future requests include cookies |
| `unbrowse_skills` | List cached skills |
| `unbrowse_skill` | Inspect a skill's endpoints |
| `unbrowse_health` | Verify the CLI is working |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNBROWSE_TIMEOUT_MS` | `120000` | Command timeout in milliseconds |
