# @unbrowse/puppeteer-shim

**One-line drop-in for `puppeteer`. $0 per cached call instead of per browser-hour.**

```diff
- import puppeteer from 'puppeteer';
+ import puppeteer from '@unbrowse/puppeteer-shim';

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('https://site.com/data');
  const html = await page.content();
  await browser.close();
```

`page.goto()` short-circuits through Unbrowse's marketplace cache. Cache hit →
free synthesized response served to `content()` / `title()` / `url()`. Miss →
falls through to the real `puppeteer` (an optional peer dep) so your existing
code keeps working — you only pay per cached call instead of per browser-hour
for any URL already indexed.

## Install

```bash
npm i @unbrowse/puppeteer-shim
# optional, for live-DOM fallback on cache misses:
npm i puppeteer
```

No API key required for cached reads. Set `UNBROWSE_API_KEY` /
`UNBROWSE_X_PAYMENT` to route paid endpoints.

## Honest scope

`goto`/`content`/`title`/`url`, and `evaluate(() => document.title)` /
`evaluate(() => document.documentElement.outerHTML)`, are served from the cached
body. Anything needing a live DOM — `click`, `type`, `screenshot`,
`waitForSelector`, non-trivial `evaluate` — requires the real puppeteer
fallback to be installed.

## Attribution

This shim mirrors the public surface of
[`puppeteer`](https://github.com/puppeteer/puppeteer) (Apache-2.0). On a cache
miss it IS puppeteer; the shim only lowers cost on hits, never replaces it.
