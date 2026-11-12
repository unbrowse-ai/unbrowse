# Unbrowse

Unbrowse is the open-source CLI and `@unbrowse/sdk` TypeScript client for the hosted Unbrowse service (`https://unbrowse.ai`), which calls websites' first-party APIs instead of running a browser. It makes agentic browsing 50-100x faster (67 ms cached, or 950 ms uncached vs 3,404 ms with browser automation, 3.6x across 94 domains) and 95% cheaper than using a browser.

```bash
npx -y unbrowse setup && npx -y unbrowse login
```

Set up every agent on this machine (skills, an always-use rule, MCP) with the command above. Or tell your agent: `set up unbrowse - https://raw.githubusercontent.com/unbrowse-ai/unbrowse/main/llms.txt`. Skill only: `npx skills add unbrowse-ai/unbrowse --skill unbrowse`.

Connect your agent:

```bash
claude mcp add --transport http unbrowse https://unbrowse.ai/mcp
```

Complete OAuth sign-in in your client. From a terminal: `npx unbrowse login` (OAuth in your browser, nothing to paste), then `npx unbrowse run 'top stories on hacker news'`.

[Install](docs/install.md) · [CLI](docs/cli.md) · [MCP](docs/mcp.md) · [SDK](docs/sdk.md) · [Troubleshooting](docs/troubleshooting.md)

## When to use it

| Your agent needs to | With a browser | With Unbrowse |
| --- | --- | --- |
| Use a site without an official API or MCP | Uses a browser | Replays the site's own first-party HTTP requests with no browser |
| Get an uncached answer (mean across 94 domains) | 3,404 ms with browser automation | 950 ms through a learned route (3.6x faster) |
| Call a cached route or repeat a task | Runs a browser each time | Answers in 67 ms cached, 50-100x faster and 95% cheaper |
| Automate a new site flow | Uses a browser every run | Learns once from a recorded cloud browser or two HAR recordings, then runs as a one-call capability |

## How it works

1. **Discover.** Unbrowse searches your private capabilities, then a public registry of sites already compiled into tools.
2. **Run.** A matching capability replays the site's own first-party HTTP requests. No browser. A run succeeds only when its result is verified.
3. **Learn once.** No match: an agent does the task in Unbrowse's recorded cloud browser (MCP), or you upload two HAR recordings (`unbrowse learn`). Unbrowse compiles the requests into a one-call capability. Next time is step 2.

Passwords stay in the Unbrowse password manager; the CLI never takes one.

More: [docs/how-it-works.md](docs/how-it-works.md) · Paper: [Internal APIs Are All You Need](docs/whitepaper/README.md) ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694))

## Commands

```text
unbrowse login [--key ub_live_…]    sign in (browser OAuth) or store an API key
unbrowse discover <query>           your capabilities, then the public registry
unbrowse run <task…> [--set k=v]    run a task from your IP (--from-unbrowse: from Unbrowse); waits for a verified result
unbrowse resume <runId> k=v…        answer what the run asked for, on the same run
unbrowse scrape <url>               read one page as markdown
unbrowse index <url>                teach Unbrowse a site: each flow becomes a tool
unbrowse learn a.har b.har          compile two recordings into a capability
unbrowse logins                     saved logins, masked
unbrowse registry [query]           public compiled sites (no account)
```

All commands: [docs/cli.md](docs/cli.md). Exit codes: 0 ok, 1 error, 2 input required, 3 sign-in or login needed, 4 not verified.

## SDK

```ts
import { Unbrowse } from "@unbrowse/sdk";
const ub = new Unbrowse(); // UNBROWSE_API_KEY
const run = await ub.wait((await ub.run({ task: "top stories on Hacker News", idempotencyKey: crypto.randomUUID() })).runId);
```

Supported REST methods: [docs/sdk.md](docs/sdk.md).

## Agents

Agents connect to the hosted MCP (`https://unbrowse.ai/mcp`, see [docs/install.md](docs/install.md)) and follow [skill/SKILL.md](skill/SKILL.md). The CLI is the REST alternative. `unbrowse mcp` runs a local stdio proxy to the hosted MCP for hosts that need stdio or plain tool names (`unbrowse_scrape`).

When Unbrowse itself breaks, agents follow [skills/unbrowse-contribute](skills/unbrowse-contribute/SKILL.md): `unbrowse bug` writes the report, and the agent opens a fix PR here (after asking the person).

Plugins for Claude Code, Codex, Grok Build, OpenClaw, Hermes and elizaOS bundle the skill and make Unbrowse the host's browser: [plugins/](plugins/README.md). Grok, ChatGPT, Claude, Perplexity, Le Chat and Gemini CLI connect as a custom connector: [docs/connect.md](docs/connect.md).

## Pricing

Check your current account plan and `unbrowse usage` for quota and pricing. [docs/pricing.md](docs/pricing.md)

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

## FAQ

### What is Unbrowse?
Unbrowse is a service (`https://unbrowse.ai`), CLI (`unbrowse`), and TypeScript SDK (`@unbrowse/sdk`) that calls websites' first-party backend APIs instead of using a browser. Every website relies on a first-party API even without an official API or MCP, and Unbrowse compiles those HTTP requests into verified one-call capabilities.

### How does Unbrowse differ from browser automation like Playwright or browser-use?
Instead of driving a browser on every run, Unbrowse replays a site's first-party HTTP requests directly. Across 94 domains, a learned route averages 950 ms uncached versus 3,404 ms for browser automation (3.6x faster), and 67 ms when cached. Overall, it is 50-100x faster and 95% cheaper than using a browser.

### Does Unbrowse need a browser?
No browser is used when running a matched capability. If no capability matches yet, an agent learns the task once in Unbrowse's recorded cloud browser (via MCP) or from two uploaded HAR recordings (`unbrowse learn`). Unbrowse compiles those requests so future runs execute via HTTP without a browser.

### How do I connect Unbrowse to Claude or another MCP client?
Run `npx -y unbrowse setup && npx -y unbrowse login` to configure every agent on your machine, or add the hosted MCP directly with `claude mcp add --transport http unbrowse https://unbrowse.ai/mcp` and complete OAuth sign-in. For hosts needing stdio, run `unbrowse mcp`. Plugins and custom connectors are also available.

### What does Unbrowse cost?
Unbrowse makes agentic browsing 95% cheaper than using a browser. You can view the public registry without an account using `unbrowse registry`. For your specific quota and plan pricing, check your account plan, run `unbrowse usage`, or read `docs/pricing.md`.
