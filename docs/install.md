# Install and make your first request

Pick what you need. Installing the skill adds instructions; connecting MCP or signing in to the CLI supplies access.

| You want | Install |
|---|---|
| An agent that can discover, browse and call sites | Remote MCP plus the skill |
| Shell commands and scripts | CLI |
| A TypeScript integration | SDK |
| Notes, plans and results appearing live | Remote MCP plus the signed-in [canvas](https://unbrowse.ai/app/canvas) |

## Agent skill

From a terminal with Node and npm:

```sh
npx skills add unbrowse-ai/unbrowse-skill --skill unbrowse
```

Choose your agent in the installer. Restart or reload its skills if needed. This uses the [skills installer](https://github.com/vercel-labs/skills). To install manually, copy the **whole `skill` directory**, including `references`, into your agent's skill directory as `unbrowse`. For Codex use `~/.agents/skills/unbrowse`; for Claude Code use `~/.claude/skills/unbrowse`.

The skill alone doesn't connect an account. Add MCP next.

## Remote MCP

```sh
claude mcp add --transport http unbrowse https://unbrowse.ai/mcp
```

Complete OAuth in your client's browser sign-in. For other clients, see [MCP configuration](mcp.md). Use the same Unbrowse account in your agent and console if you want the same saved sites and canvas.

First ask: “Use Unbrowse to discover tools for Hacker News. Show which match, without posting anything.” Confirm real returned tools before running one. If no capability fits, the agent can use Unbrowse's cloud browser to learn a route; support varies by site.

## CLI — hosted client preview

Node 18.17+ is required; Node 22 is used for release verification. The npm `latest` tag may still be the older client. Install this version's GitHub release explicitly:

```sh
npm install -g https://github.com/unbrowse-ai/unbrowse-skill/releases/download/v12.0.0-alpha.1/unbrowse-12.0.0-alpha.1.tgz
unbrowse --version
unbrowse registry wikipedia
unbrowse login
unbrowse discover "Hacker News"
```

`registry` works without sign-in. `discover` uses your workspace. Choose a returned capability and its actual inputs before calling `unbrowse run --capability ID --input '{"query":"your search"}'`; replace the example input with that capability's schema. More: [CLI reference](cli.md).

For headless automation, set `UNBROWSE_API_KEY` through a secret manager. Avoid `login --key` in shell history; environment configuration needs no stored login. Never commit the key.

## SDK

```sh
npm install https://github.com/unbrowse-ai/unbrowse-skill/releases/download/v12.0.0-alpha.1/unbrowse-sdk-12.0.0-alpha.1.tgz
```

```ts
import { Unbrowse } from '@unbrowse/sdk';
const client = new Unbrowse(); // UNBROWSE_API_KEY for authenticated operations
console.log(await client.sites('wikipedia')); // public, no key required
```

[SDK reference](sdk.md) · [Troubleshooting](troubleshooting.md) · [Release process](release.md)
