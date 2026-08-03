# @unbrowse/stagehand-shim

**One-line drop-in for `@browserbasehq/stagehand`. $0 on cache hits.**

```diff
- import { Stagehand } from '@browserbasehq/stagehand';
+ import { Stagehand } from '@unbrowse/stagehand-shim';

  const stagehand = new Stagehand({ env: 'BROWSERBASE', apiKey, projectId });
  await stagehand.init();
  await stagehand.page.goto('https://example.com');
  const data = await stagehand.extract('product list', mySchema);
  await stagehand.close();
```

`act` / `extract` / `observe` routed through Unbrowse's marketplace cache. Cache hit → returns immediately, no Browserbase session, no LLM screen-acting. Miss → falls through to real Stagehand (optional peer dep) with your existing Browserbase apiKey, so you pay them only on miss.

## Install

```bash
npm i @unbrowse/stagehand-shim
# Optional fallback (only fires on cache miss):
npm i @browserbasehq/stagehand
```

## Env

| Var | Meaning |
|---|---|
| `UNBROWSE_API_KEY` / `UNBROWSE_X_PAYMENT` | Auth for Unbrowse path |
| `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` | Already-set Browserbase fallback |
| `UNBROWSE_API_URL` | Override default `https://beta-api.unbrowse.ai` |

## What works on cache hit

| Method | Behavior |
|---|---|
| `new Stagehand(config)` | Stateless constructor |
| `init()` | No-op — no browser spawn |
| `page.goto(url)` | Remembers URL for next resolve call |
| `act(intent)` | Resolves URL+intent via marketplace; returns `ActResult` on hit |
| `extract(instruction, schema)` | Returns structured data from marketplace endpoint |
| `close()` | Tears down any real-Stagehand instance that was spawned mid-flight |

## What falls through to real Stagehand

- `observe()` — Unbrowse doesn't model "observable elements on a live DOM" in v0.1.
- Anything called after a cache miss — once the shim spawns a real Stagehand, subsequent calls go through it.

## Cost comparison

| Browserbase tier | Monthly cost | Then |
|---|---|---|
| Free | $0 | 1 hr/mo, then refuse |
| Dev | $20 | 100 hrs included, $0.12/hr after |
| Startup | $99 | 500 hrs, $0.10/hr after |
| **`@unbrowse/stagehand-shim`** | $0 base | $0 on cache hits; falls back to your existing tier on miss |

The break-even is at 0% cache rate (you pay the same as today). Anything above is direct savings.

## Stickiness loop

Every fall-through Stagehand session publishes captured routes back to Unbrowse's marketplace under your wallet. Next call from any caller becomes a cache hit. You earn x402 micropayments when other agents hit your contributed routes.

## License

MIT.
