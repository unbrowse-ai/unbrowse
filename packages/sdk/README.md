# @unbrowse/sdk

Thin TypeScript SDK for the canonical Unbrowse local server API.

This is the narrow surface:

- `resolve()` for intent -> search/capture/execute
- `execute()` for explicit skill replays
- `login()` / `importAuth()` for gated sites
- `search()`, `searchDomain()`, `getSkill()`, `feedback()`, `stats()`, `health()`

The SDK wraps the same local server routes the CLI uses. No second product surface.

## Install

```bash
npm install @unbrowse/sdk
```

You still need the local Unbrowse server running:

```bash
npx unbrowse setup
```

That starts the default local server at `http://localhost:6969`.

## Quick start

```ts
import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = new Unbrowse({
  baseUrl: process.env.UNBROWSE_URL,
  apiKey: process.env.UNBROWSE_API_KEY,
});

const resolved = await unbrowse.resolve({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});

console.log(resolved.result);
```

## Explicit execute

```ts
const resolved = await unbrowse.resolve({
  intent: "get feed posts",
  url: "https://news.ycombinator.com",
});

const rerun = await unbrowse.execute(resolved, {
  projection: { raw: true },
});
```

You can also execute by skill id:

```ts
const result = await unbrowse.execute("skill_123", {
  params: { symbol: "NVDA" },
});
```

## Auth

Interactive login:

```ts
await unbrowse.login({ url: "https://calendar.google.com" });
```

Import cookies from your browser storage first:

```ts
await unbrowse.importAuth({
  url: "https://x.com/home",
  browser: "auto",
});
```

## Search

```ts
const global = await unbrowse.search({
  intent: "get stock prices",
  k: 5,
});

const domain = await unbrowse.searchDomain({
  intent: "find trending repositories",
  domain: "github.com",
  k: 3,
});
```

## Error handling

```ts
import { Unbrowse, UnbrowseApiError } from "@unbrowse/sdk";

try {
  await unbrowse.resolve({ intent: "get inbox", url: "https://mail.google.com" });
} catch (error) {
  if (error instanceof UnbrowseApiError) {
    console.error(error.status, error.path, error.data);
  }
  throw error;
}
```

## Notes

- Default `baseUrl` is `http://localhost:6969`.
- Default `apiKey` reads from `UNBROWSE_API_KEY` when present.
- `resolve({ url })` maps the URL into both `params.url` and `context.url`, matching the CLI path.
- Response types are intentionally strongest on inputs and core trace/skill metadata, lighter on payload bodies, because endpoint payload shape varies by site.
