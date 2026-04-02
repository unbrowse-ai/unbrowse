# API Documentation

Unbrowse has one canonical local surface: the server on `http://localhost:6969`.

Everything else should wrap that:

- CLI
- skill host integration
- TypeScript SDK

The new SDK lives in [`packages/sdk`](../packages/sdk/README.md) and is intentionally thin. Same routes. Less ceremony.

## Start the local server

```bash
npx unbrowse setup
```

Default base URL:

```txt
http://localhost:6969
```

## TypeScript SDK

Install:

```bash
npm install @unbrowse/sdk
```

Basic resolve:

```ts
import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = new Unbrowse();

const resolved = await unbrowse.resolve({
  intent: "get feed posts",
  url: "https://news.ycombinator.com",
});
```

Explicit execute:

```ts
const rerun = await unbrowse.execute(resolved, {
  projection: { raw: true },
});
```

Auth:

```ts
await unbrowse.importAuth({
  url: "https://x.com/home",
  browser: "auto",
});

await unbrowse.login({
  url: "https://calendar.google.com",
});
```

## REST routes

Core routes the SDK wraps:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/intent/resolve` | Canonical resolve path, search/capture/execute |
| `POST` | `/v1/skills/:skill_id/execute` | Explicit replay of a learned skill |
| `GET` | `/v1/skills/:skill_id` | Fetch a skill manifest |
| `POST` | `/v1/auth/login` | Interactive login |
| `POST` | `/v1/auth/steal` | Import browser auth material |
| `POST` | `/v1/search` | Global marketplace search |
| `POST` | `/v1/search/domain` | Domain-scoped marketplace search |
| `POST` | `/v1/feedback` | Send endpoint feedback |
| `GET` | `/v1/stats` | Public product stats |
| `GET` | `/health` | Health check |

## Resolve request

`resolve()` is the main thing.

SDK input:

```ts
await unbrowse.resolve({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
  params: { timezone: "Asia/Singapore" },
  projection: { raw: true },
  dryRun: false,
  forceCapture: false,
});
```

REST body sent:

```json
{
  "intent": "list tomorrow's events",
  "params": {
    "url": "https://calendar.google.com",
    "timezone": "Asia/Singapore"
  },
  "context": {
    "url": "https://calendar.google.com"
  },
  "projection": {
    "raw": true
  }
}
```

Important detail: the SDK mirrors the CLI by copying `url` into both `params.url` and `context.url`. That keeps ranking and replay behavior aligned with the product path.

## Execute request

Use `execute()` when you already know the skill you want.

```ts
await unbrowse.execute("skill_123", {
  params: { symbol: "NVDA" },
  contextUrl: "https://finance.yahoo.com/quote/NVDA",
});
```

Or from a previous resolve response:

```ts
const resolved = await unbrowse.resolve({
  intent: "get stock prices",
  url: "https://finance.yahoo.com",
});

await unbrowse.execute(resolved, {
  params: { symbol: "NVDA" },
});
```

## Auth routes

Two paths:

- `importAuth()` / `/v1/auth/steal`: try browser cookies first
- `login()` / `/v1/auth/login`: open interactive login when needed

That matches the CLI auth fallback order.

## Errors

SDK failures throw `UnbrowseApiError`.

```ts
import { UnbrowseApiError } from "@unbrowse/sdk";

try {
  await unbrowse.login({ url: "https://calendar.google.com" });
} catch (error) {
  if (error instanceof UnbrowseApiError) {
    console.error(error.status);
    console.error(error.path);
    console.error(error.data);
  }
}
```

## Response shape

Inputs are strongly typed. Response payload bodies stay intentionally loose because each site returns different data.

Stable fields you can rely on:

- `trace`
- `skill`
- `timing`
- `source`
- `available_endpoints`
- `result`

The variable part is `result`.
