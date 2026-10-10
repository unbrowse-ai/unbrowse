# Installing the Unbrowse MCP server (for Cline and other agents)

Unbrowse is a hosted service (free tier available) that turns websites into APIs agents call:
read any page as clean markdown, run tasks on sites through learned first-party APIs without a
browser, and use a cloud browser with saved logins when nothing matches. Its MCP server is
hosted at `https://unbrowse.ai/mcp`. Nothing needs to be cloned or built.

## 1. Get an API key

Ask the user to sign in at https://unbrowse.ai/app and create a key (it starts with `ub_live_`).
Do not invent or guess a key. Never write the key into a repository file.

## 2. Add the server to Cline's MCP settings

Pick one option and add it under `mcpServers` in `cline_mcp_settings.json`.

### Option A: remote server (recommended, no local install)

```json
{
  "mcpServers": {
    "unbrowse": {
      "type": "streamableHttp",
      "url": "https://unbrowse.ai/mcp",
      "headers": {
        "Authorization": "Bearer ub_live_YOUR_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Clients that support MCP OAuth can omit `headers` and sign in in the browser when prompted
(OAuth 2.1 with PKCE and dynamic client registration).

### Option B: local stdio proxy (Node 18.17+)

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse@12.2.1-preview.0", "mcp"],
      "env": {
        "UNBROWSE_API_KEY": "ub_live_YOUR_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`unbrowse mcp` is a stdio proxy to the hosted server. Tool names use underscores
(`unbrowse_scrape`, `unbrowse_discover`, `unbrowse_run`, `unbrowse_browse_open`). Instead of
`UNBROWSE_API_KEY` it can use a prior `npx unbrowse login`.

## 3. Verify

After saving, the server should list tools. Try:

- "Use Unbrowse to read https://news.ycombinator.com as markdown."
- "Use Unbrowse to discover tools for Hacker News. Show which match, without posting anything."

If tools fail with `unauthorized`, the key is missing or wrong: set it and restart the server.
More: [docs/mcp.md](docs/mcp.md) and [docs/troubleshooting.md](docs/troubleshooting.md).
