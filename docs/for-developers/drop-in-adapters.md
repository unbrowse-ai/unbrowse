# Drop-in Adapters

Unbrowse ships a **zero-edit drop-in** for the libraries you already use. Change one
import line and your existing code keeps its exact API — every safe `GET`/search/scrape
first routes through Unbrowse's resolved-route cache (free on a hit), and anything that
misses falls back to native `fetch` or the upstream library, so behaviour is preserved
and only cost drops.

Every adapter below is parity-verified: each ships a test proving it provides the
upstream's public surface (`scripts/dropin-parity-gate.sh`), and adding a new library
means adding a row to `scripts/dropin-manifest.tsv` — the row stays red until its
drop-in is built to parity. Each shim's README attributes the upstream project and
states the swap.

Configure once (optional): `UNBROWSE_API_URL` (defaults to the hosted API),
`UNBROWSE_API_KEY`, and `UNBROWSE_X_PAYMENT` for paid execution.

## HTTP clients

These provide the upstream client's surface; a safe `GET` routes through Unbrowse's
resolve + execute marketplace cache, everything else is native `fetch` shaped into the
library's response type.

| Upstream | Drop-in | Swap |
|---|---|---|
| `fetch` (WHATWG) | `@unbrowse/client` | `import { fetch } from '@unbrowse/client'` |
| `axios` | `@unbrowse/axios-shim` | `import axios from '@unbrowse/axios-shim'` |
| `got` | `@unbrowse/got-shim` | `import got from '@unbrowse/got-shim'` |
| `ky` | `@unbrowse/ky-shim` | `import ky from '@unbrowse/ky-shim'` |
| `node-fetch` | `@unbrowse/node-fetch-shim` | `import fetch from '@unbrowse/node-fetch-shim'` |
| `cross-fetch` | `@unbrowse/cross-fetch-shim` | `import fetch from '@unbrowse/cross-fetch-shim'` |
| `undici` | `@unbrowse/undici-shim` | `import { request, fetch } from '@unbrowse/undici-shim'` |
| `superagent` | `@unbrowse/superagent-shim` | `import request from '@unbrowse/superagent-shim'` |
| `wretch` | `@unbrowse/wretch-shim` | `import wretch from '@unbrowse/wretch-shim'` |

```diff
- import got from 'got';
+ import got from '@unbrowse/got-shim';

  const data = await got('https://api.site.com/items').json(); // unchanged
```

## Browser automation

These provide the automation library's surface; navigation and page reads are backed by
an Unbrowse browse session, with the upstream's locator/waiter API preserved.

| Upstream | Drop-in | Swap |
|---|---|---|
| `playwright` | `@unbrowse/playwright-shim` | `import { chromium } from '@unbrowse/playwright-shim'` |
| `puppeteer` | `@unbrowse/puppeteer-shim` | `import puppeteer from '@unbrowse/puppeteer-shim'` |
| `selenium-webdriver` | `@unbrowse/selenium-shim` | `import { Builder, By, until } from '@unbrowse/selenium-shim'` |
| `@browserbasehq/stagehand` | `@unbrowse/stagehand-shim` | `import { Stagehand } from '@unbrowse/stagehand-shim'` |

## Search, scraping & retrieval

These provide the retrieval SDK's surface; the query routes through Unbrowse's
resolve + execute and synthesizes the upstream's result shape, falling back to the
upstream API only when its own key is present.

| Upstream | Drop-in | Swap |
|---|---|---|
| `@mendable/firecrawl-js` | `@unbrowse/firecrawl-shim` | `import Firecrawl from '@unbrowse/firecrawl-shim'` |
| `exa-js` | `@unbrowse/exa-shim` | `import Exa from '@unbrowse/exa-shim'` |
| `@tavily/core` | `@unbrowse/tavily-shim` | `import { tavily } from '@unbrowse/tavily-shim'` |

```diff
- import Exa from 'exa-js';
+ import Exa from '@unbrowse/exa-shim';

  const { results } = await new Exa(process.env.EXA_API_KEY).searchAndContents('agent infra'); // unchanged
```

## Core SDK (not a shim)

When you are not replacing an existing library, start from the native surfaces:

| Surface | Install | Use it when |
|---|---|---|
| `@unbrowse/client` | `npm install @unbrowse/client` | Browser, edge, or Node TypeScript/JavaScript |
| MCP server | `npx unbrowse mcp` | Wiring an agent host (Claude, Cursor, Codex, any MCP client) |
| CLI | `npx unbrowse` | Shell scripts, CI, one-off use |

See [Integration Surfaces](./integration-surfaces.md) and the [SDK Quickstart](./sdk-quickstart.md).

## Honest scope

A drop-in preserves the upstream's **public API surface**, not every private internal.
Where a library has capabilities Unbrowse does not yet back natively (recursive site
crawls, sitemap mapping, live interactive clicks), the shim falls back to native `fetch`
or the upstream API and says so in its README. The contract you import never changes;
only what happens behind it improves on a cache hit.
