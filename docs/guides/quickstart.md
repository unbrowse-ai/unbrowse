# Quickstart

Install the current Unbrowse CLI and run setup:

```bash
npm install -g unbrowse@11.1.1
unbrowse setup
```

Setup installs the Agent Skill. MCP integration is optional:

```bash
unbrowse setup --mcp
```

## Your first result

The default interface is one command: describe the result you want and provide
a site when it helps.

```bash
unbrowse "top stories with point counts" --url https://news.ycombinator.com
```

Unbrowse first looks for a reusable route. On a miss, it can open the browser,
learn the site flow, and reuse that route on later calls.

Useful diagnostics:

```bash
unbrowse health
unbrowse resolve --intent "get stock prices" --url https://finance.yahoo.com --no-execute
unbrowse fetch https://example.com
```

For sites that require a login:

```bash
unbrowse auth https://calendar.google.com
```

## Connect an account

Register once to create an API key and attach usage credits:

```bash
unbrowse register --email you@example.com
unbrowse dashboard
```

Unbrowse uses credits for metered work. No separate financial setup is required.
Credits earned by contributing maintained routes remain on your account and can
be redeemed later when redemption is available.

## TypeScript

```bash
npm install unbrowse@11.1.1
```

```ts
import { createHole } from "unbrowse/sdk";

const result = await createHole().fill({
  intent: "get trending searches",
  url: "https://google.com",
});

console.log(result.answer ?? result.items);
```

See [the SDK quickstart](../for-developers/sdk-quickstart.md) for the lower-level
resolve/execute client, credit balances, retries, and typed errors.
