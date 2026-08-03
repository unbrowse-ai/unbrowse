# @unbrowse/playwright-shim

**One-line drop-in for `playwright`. Pays per-call instead of per-browser-hour.**

```diff
- import { chromium } from 'playwright';
+ import { chromium } from '@unbrowse/playwright-shim';
```

Every `page.goto(url)` is rewritten to `unbrowse.resolve(url) → unbrowse.execute(endpoint_id)` — a single HTTP call against the marketplace cache. If the URL+intent matches a published route, you get the data back synthesized as a `Response` your existing code reads with `.text()`, `.json()`, `.content()`. If nothing's cached, the shim falls through to real `playwright` (install it as a peer dep) or throws a clear error so you can capture the URL once.

## Install

```bash
npm i @unbrowse/playwright-shim
# Optional fallback for cache misses:
npm i playwright
```

## Env

| Var | Meaning |
|---|---|
| `UNBROWSE_API_KEY` | Bearer token. Get one at <https://unbrowse.ai/dashboard>. |
| `UNBROWSE_X_PAYMENT` / `X_PAYMENT` | x402 envelope for per-call payment (no API key required). |
| `UNBROWSE_API_URL` | Override default `https://beta-api.unbrowse.ai`. |
| `UNBROWSE_INTENT_HINT` | When the shim can't infer a good intent from the URL path, this hint is used. |

## What works on cache hit

| Method | Behavior |
|---|---|
| `chromium.launch()` | Returns a fake browser. No process spawn. |
| `browser.newContext()` / `browser.newPage()` | Stateless objects. No resource cost. |
| `page.goto(url, opts)` | Resolves via marketplace; returns a synthesized `Response`. |
| `page.content()` | Returns the cached body as text. |
| `page.title()` | Pulled from cached HTML `<title>` if present, else empty. |
| `page.url()` | The url you `goto`'d. |
| `page.evaluate('document.title')` | Resolved from cached body. |

## What falls through to real playwright

- `page.click()`, `page.fill()`, `page.type()`, `page.screenshot()` — require live DOM, no cache substitute.
- `page.evaluate(fn)` with non-trivial functions.
- `chromium.connectOverCDP(ws)` — passes through to real playwright with no shim.

If `playwright` isn't installed and you call one of these, you get a clear error telling you what to do.

## Cost comparison

| Provider | $/browser-hour | What you pay for |
|---|---|---|
| Browserbase | $0.10-$0.12 | Every minute a browser is alive |
| Bright Data Scraping Browser | $5-$8 per GB | Bandwidth + JS render |
| Real Playwright on your own infra | infra + bandwidth + dev time | Whatever your fleet costs |
| **`@unbrowse/playwright-shim` on cache hit** | **$0** | The marketplace already has the route indexed |
| Live capture fallback | per-call x402 micropayment | Settles via Faremeter Flex |

The dollar math: a Browserbase team running 100 hrs/month pays $12-$120. The same team using this shim, with 60% of their target URLs already in the unbrowse marketplace, pays $4.80-$48 on the 40% miss rate. **2-3x cost savings on day one; more as the marketplace grows.**

## Stickiness — the marketplace gets denser the more you use it

Every cache miss that falls through to live capture publishes the captured routes back to the marketplace under your wallet. The next call from anyone, anywhere, becomes a cache hit. You earn x402 micropayments when other agents use what you indexed.

This is the same pattern OSS dependencies have: you contribute once, everyone benefits forever, but you keep getting paid for your contribution.

## Limitations (be honest)

- The shim is **not** a 100% playwright API. ~80% of the public surface is covered; specialized features (route mocking, network interception, mobile emulation, multi-page coordination) require the real `playwright`.
- The shim is **stateless on cache hits** — there's no live browser running, so things that depend on a live tab (cookies set during interactive flow, JS state across `goto` calls) don't carry over. For those, install `playwright` as a peer and the shim will use it transparently on first miss.
- This is v0.1. Surface area will grow; file issues at <https://github.com/unbrowse-ai/unbrowse/issues> for any specific method you hit.

## License

MIT.
