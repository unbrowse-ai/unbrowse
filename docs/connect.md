# Connect Unbrowse to your assistant

Unbrowse is a remote MCP server: `https://unbrowse.ai/mcp` (Streamable HTTP, OAuth sign-in). Any assistant that accepts a custom MCP connector can use it. Sign-in happens in the assistant's OAuth window; you never paste a key into a chat.

| Assistant | Where | What to enter |
|---|---|---|
| Grok (grok.com) | [grok.com/connectors](https://docs.x.ai/grok/connectors) → New Connector → Custom | URL `https://unbrowse.ai/mcp`, then sign in. On Business and Enterprise an admin adds it first ([connector management](https://docs.x.ai/grok/connector-management)) |
| ChatGPT | Developer mode, then add an MCP app ([help](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)) | URL `https://unbrowse.ai/mcp`, authentication OAuth |
| Claude | Settings → Connectors → Add custom connector | URL `https://unbrowse.ai/mcp` |
| Perplexity | Settings → Connectors → + Custom connector → Remote ([help](https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors)) | URL `https://unbrowse.ai/mcp`, transport Streamable HTTP, auth OAuth |
| Le Chat (Mistral) | Connectors → custom MCP connector ([docs](https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors)) | URL `https://unbrowse.ai/mcp` |
| Gemini CLI | `gemini extensions install https://github.com/unbrowse-ai/unbrowse` | Loads the remote server and the Unbrowse skill (`gemini-extension.json`) |
| xAI API | Responses API tool `{"type": "mcp", "server_url": "https://unbrowse.ai/mcp", "server_label": "unbrowse", "headers": {"Authorization": "Bearer <UNBROWSE_API_KEY>"}}` ([docs](https://docs.x.ai/developers/tools/remote-mcp)) | An API key from [unbrowse.ai/app](https://unbrowse.ai/app) |

Coding agents (Claude Code, Codex, Grok Build, OpenClaw, Hermes, elizaOS) have plugins that also redirect the built-in browser to Unbrowse: [plugins/](../plugins/README.md). Hosts that need a local stdio server: `npx -y unbrowse mcp`.

What to try first: "Read https://news.ycombinator.com with Unbrowse and list the top 5 stories", then a task on a site you use, for example "Find flights from SIN to NRT next Friday on <site>". The first run on a new site may use the cloud browser; Unbrowse learns the route, so later runs are plain API calls.
