# Unbrowse

Call websites as APIs. This is the open-source client for the hosted Unbrowse service
(`https://unbrowse.ai`): the `@unbrowse/sdk` TypeScript client for its REST API, and the
`unbrowse` CLI built on it.

Install the agent skill:

```bash
npx skills add unbrowse-ai/unbrowse-skill --skill unbrowse
```

Connect your agent:

```bash
claude mcp add --transport http unbrowse https://unbrowse.ai/mcp
```

Complete OAuth sign-in in your client. **For the CLI or SDK, use the pinned hosted-client release in [the installation guide](docs/install.md)**; npm `latest` may still target the older service.

[Install](docs/install.md) · [CLI](docs/cli.md) · [MCP](docs/mcp.md) · [SDK](docs/sdk.md) · [Troubleshooting](docs/troubleshooting.md)

## How it works

1. **Discover.** Unbrowse searches your private capabilities, then a public registry of sites
   already compiled into tools.
2. **Run.** A matching capability replays the site's own first-party HTTP requests. No browser.
   A run succeeds only when its result is verified.
3. **Learn once.** No match: an agent does the task in Unbrowse's recorded cloud browser (MCP), or
   you upload two HAR recordings (`unbrowse learn`). Unbrowse compiles the requests into a
   one-call capability. Next time is step 2.

Passwords stay in the Unbrowse password manager; the CLI never takes one.

More: [docs/how-it-works.md](docs/how-it-works.md) · Paper: [Internal APIs Are All You Need](docs/whitepaper/README.md) (arXiv:2604.00694)

## Commands

```text
unbrowse login [--key ub_live_…]    sign in (browser OAuth) or store an API key
unbrowse discover <query>           your capabilities, then the public registry
unbrowse run <task…> [--set k=v]    run a task from your IP (--from-unbrowse: from Unbrowse); waits for a verified result
unbrowse resume <runId> k=v…        answer what the run asked for, on the same run
unbrowse learn a.har b.har          compile two recordings into a capability
unbrowse logins                     saved logins, masked
unbrowse registry [query]           public compiled sites (no account)
```

All commands: [docs/cli.md](docs/cli.md). Exit codes: 0 ok, 1 error, 2 input required,
3 sign-in or login needed, 4 not verified.

## SDK

```ts
import { Unbrowse } from "@unbrowse/sdk";
const ub = new Unbrowse(); // UNBROWSE_API_KEY
const run = await ub.wait((await ub.run({ task: "top stories on Hacker News", idempotencyKey: crypto.randomUUID() })).runId);
```

Supported REST methods: [docs/sdk.md](docs/sdk.md).

## Agents

Agents connect to the hosted MCP (`https://unbrowse.ai/mcp`, see [docs/install.md](docs/install.md))
and follow [skill/SKILL.md](skill/SKILL.md). The CLI is the REST alternative. `unbrowse mcp` runs a local
stdio proxy to the hosted MCP for hosts that need stdio or plain tool names (`unbrowse_scrape`).

Plugins for Claude Code, Codex, Grok Build, OpenClaw, Hermes and elizaOS bundle the skill and make
Unbrowse the host's browser: [plugins/](plugins/README.md). Grok, ChatGPT, Claude, Perplexity, Le Chat and
Gemini CLI connect as a custom connector: [docs/connect.md](docs/connect.md).

## Pricing

Check your current account plan and `unbrowse usage` for quota and pricing.
[docs/pricing.md](docs/pricing.md)

## Develop

```bash
bun install
bun test packages     # SDK route tests + CLI tests against a local stand-in API
bun run typecheck
bun run build         # packages/sdk/dist, packages/cli/dist/cli.js (Node 18.17+)
bun run cli help
```

## Release

CI/CD publishes on a version tag: [docs/release.md](docs/release.md).

What is here and what stays hosted: [docs/open-source.md](docs/open-source.md). MIT © Unbrowse AI
