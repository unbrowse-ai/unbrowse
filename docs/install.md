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
npx skills add unbrowse-ai/unbrowse --skill unbrowse
```

Choose your agent in the installer. Restart or reload its skills if needed. This uses the [skills installer](https://github.com/vercel-labs/skills). To install manually, copy the **whole `skill` directory**, including `references`, into your agent's skill directory as `unbrowse`. For Codex use `~/.agents/skills/unbrowse`; for Claude Code use `~/.claude/skills/unbrowse`.

The skill alone doesn't connect an account. Add MCP next.

## Remote MCP

```sh
claude mcp add --transport http unbrowse https://unbrowse.ai/mcp
```

Complete OAuth in your client's browser sign-in. For other clients, see [MCP configuration](mcp.md). Use the same Unbrowse account in your agent and console if you want the same saved sites and canvas.

First ask: “Use Unbrowse to discover tools for Hacker News. Show which match, without posting anything.” Confirm real returned tools before running one. If no capability fits, the agent can use Unbrowse's cloud browser to learn a route; support varies by site.

## CLI

Node 18.17+ is required; Node 22 is used for release verification.

```sh
npx unbrowse login
npx unbrowse whoami
npx unbrowse run 'top stories on hacker news'
```

`login` signs in with OAuth in your browser: enter your email, open the emailed link, press **Allow**. Nothing to paste; the CLI prints `Signed in to https://unbrowse.ai (workspace ws_…)` and keeps the token in `~/.config/unbrowse/cli.json` (mode 0600, refreshed automatically). Any command run with no sign-in starts the same sign-in when it has a terminal; without one it exits 3.

From an agent's shell, `npx unbrowse login --no-open` prints the sign-in link instead of opening it: open it in a browser **on the same machine** (it returns to `127.0.0.1`), then the command finishes. On a remote or headless box, use an API key (below).

`registry` and `site <host>` work without sign-in. `discover` uses your workspace. Choose a returned capability and its actual inputs before calling `unbrowse run --capability ID --input '{"query":"your search"}'`. More: [CLI reference](cli.md).

For headless automation, set `UNBROWSE_API_KEY` through a secret manager (create a key in the signed-in console at https://unbrowse.ai/app). Avoid `login --key` in shell history; environment configuration needs no stored login. Never commit the key.

## SDK

```sh
npm install @unbrowse/sdk
```

```ts
import { Unbrowse } from '@unbrowse/sdk';
const client = new Unbrowse(); // UNBROWSE_API_KEY for authenticated operations
console.log(await client.sites('wikipedia')); // public, no key required
```

[SDK reference](sdk.md) · [Troubleshooting](troubleshooting.md) · [Release process](release.md)
