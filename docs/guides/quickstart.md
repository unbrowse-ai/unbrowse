# Getting Started

This is the shortest path from zero to one real result.

## 1. Install and start Unbrowse

```bash
npx unbrowse setup
```

That installs the CLI on demand, verifies the runtime, and starts the local server on `http://localhost:6969`.

## 2. Try the CLI once

```bash
unbrowse resolve \
  --intent "get trending searches" \
  --url "https://google.com" \
  --pretty
```

If the site needs auth:

```bash
unbrowse login --url "https://calendar.google.com"
```

## 3. Call the same path from TypeScript

```bash
npm install @unbrowse/sdk
```

```ts
import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = new Unbrowse();

const result = await unbrowse.resolve({
  intent: "get trending searches",
  url: "https://google.com",
});

console.log(result.result);
```

## 4. Re-execute a learned skill

```ts
const resolved = await unbrowse.resolve({
  intent: "get stock prices",
  url: "https://finance.yahoo.com",
});

const rerun = await unbrowse.execute(resolved, {
  params: { symbol: "NVDA" },
});
```

## 5. Search the marketplace directly

```ts
const matches = await unbrowse.searchDomain({
  intent: "find trending repositories",
  domain: "github.com",
  k: 3,
});
```

## 6. Know the mental model

- `resolve()` is the main thing.
- It follows the canonical orchestrator path, not a side channel.
- `execute()` is for explicit replay when you already know the skill.
- `importAuth()` tries browser cookies first.
- `login()` is the interactive fallback.

## 7. Useful links

- [API docs](../api.md)
- [SDK README](../../packages/sdk/README.md)
- [Main README](../../README.md)
