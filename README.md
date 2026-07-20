# Unbrowse

Unbrowse is the action layer for AI agents. It learns a site's first-party API
routes from real browsing, then replays known routes directly instead of driving
a browser for every task.

```bash
npm install -g unbrowse@11.1.8
unbrowse setup
unbrowse "top stories with point counts" --url https://news.ycombinator.com
```

On a cache hit, Unbrowse resolves, executes, and reads the route in one call. On
a miss, it can open a real browser, observe the working request, and make that
route reusable. The browser remains available for login, consent, CAPTCHA, and
UI-only flows.

## Why Unbrowse

- **Fast on repeat work.** Known routes skip page rendering and DOM parsing.
- **Honest fallback.** Browser automation stays available when direct requests
  are not enough.
- **Local credentials.** Site sessions remain on the machine running Unbrowse.
- **One agent interface.** Use the same intent from the CLI, Agent Skill, MCP,
  or TypeScript.
- **Shared learning.** Sanitized route metadata can be published so other
  agents do not rediscover the same site flow.

The published 94-domain benchmark measured a 3.6× mean and 5.4× median speedup
for warmed cached routes over Playwright. See
[Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694) and the
[benchmark notes](docs/benchmarks.md).

## CLI

The default interface is one command:

```bash
unbrowse "task" --url https://example.com
```

Useful lower-level commands:

```bash
unbrowse health
unbrowse fetch https://example.com
unbrowse resolve --intent "search products" --url https://example.com --no-execute
unbrowse capture --url https://example.com --intent "search products"
unbrowse auth https://example.com/login
```

Use `go`, `snap`, `click`, `submit`, and `close` when a task genuinely needs the
DOM. Run `unbrowse <command> --help` for the current options.

## TypeScript SDK

The current SDK ships inside the `unbrowse` package:

```bash
npm install unbrowse@11.1.8
```

```ts
import { createHole } from "unbrowse/sdk";

const result = await createHole().fill({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});

console.log(result.answer ?? result.items);
```

Use the lower-level client when your application should inspect route choices:

```ts
import { Unbrowse } from "unbrowse/sdk";

const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });
const resolved = await unbrowse.resolve({
  intent: "find recent TypeScript releases",
  contextUrl: "https://github.com/microsoft/TypeScript/releases",
});

const endpoint = resolved.available_operations?.[0];
if (endpoint) {
  const result = await unbrowse.execute({ endpoint_id: endpoint.endpoint_id });
  console.log(result.data);
}
```

See the [SDK quickstart](docs/for-developers/sdk-quickstart.md) for retries,
typed errors, proxy options, and account resources.

## Accounts and billing

Unbrowse uses API keys for account access and credits for metered work.

```bash
unbrowse register --email you@example.com
unbrowse dashboard
```

No separate payment setup is required. Added, promotional, and earned credits
live in one account ledger.

```ts
const credits = await unbrowse.account.credits();
console.log(`${credits.balance_credits} credits`);
```

## Agent Skill and MCP

`unbrowse setup` installs the Agent Skill by default. MCP is an optional
compatibility surface:

```bash
unbrowse setup --mcp
```

The Agent Skill teaches compatible hosts the current flat CLI commands and the
preferred one-call flow.

## Development

```bash
git clone --recursive https://github.com/unbrowse-ai/unbrowse.git
cd unbrowse
bun install
./setup
bun test
```

The local runtime listens on `127.0.0.1:6969` by default. Site profiles and
credentials are stored below `~/.unbrowse/`; logs and route caches are kept
separate so they can be inspected or removed independently.

## Documentation

- [Quickstart](docs/guides/quickstart.md)
- [How an agent uses Unbrowse](docs/for-agents/how-an-agent-uses-unbrowse.md)
- [SDK quickstart](docs/for-developers/sdk-quickstart.md)
- [Billing and usage](docs/for-agents/credits.md)
- [Architecture](docs/architecture/README.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Unbrowse is MIT licensed. See the [open-source notice](docs/OPEN-SOURCE-NOTICE.md)
for the client/server boundary.
