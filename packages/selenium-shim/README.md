# @unbrowse/selenium-shim

**One-line drop-in for `selenium-webdriver`. No WebDriver server, no chromedriver, no browser binary for cached reads.**

```diff
- const { Builder, By, until, Key } = require('selenium-webdriver');
+ const { Builder, By, until, Key } = require('@unbrowse/selenium-shim');

  const driver = await new Builder().forBrowser('chrome').build();
  await driver.get('https://site.com/data');
  const html  = await driver.getPageSource();
  const title = await driver.getTitle();
  await driver.quit();
```

`driver.get()` routes through Unbrowse's resolve+execute marketplace cache.
Cache hit → the page body is synthesized and served to `getPageSource()` /
`getTitle()` / `getCurrentUrl()`, and parsed for `findElement().getText()` /
`getAttribute()` — without spinning up a WebDriver session or a real browser.

## Install

```bash
npm i @unbrowse/selenium-shim
```

No API key required for cached reads. Set `UNBROWSE_API_KEY` /
`UNBROWSE_X_PAYMENT` to route paid endpoints. Point at a different backend with
`UNBROWSE_API_URL` / `UNBROWSE_BASE` (default `https://beta-api.unbrowse.ai`).

## Deterministic / offline mode

Set `UNBROWSE_DRYRUN=1` and `driver.get()` performs **no network** — it lands on
the URL with an empty page body and synthesized empty title/source. This makes
test suites deterministic and lets the import swap compile and run with zero
infrastructure.

## Honest scope

This is a **drop-in for the read surface** of `selenium-webdriver`, with the
interaction surface kept for parity:

| Method | Backed by Unbrowse | Notes |
| --- | --- | --- |
| `Builder.forBrowser/withCapabilities/setChromeOptions/build` | yes | fluent, returns a `WebDriver` |
| `driver.get` / `getPageSource` / `getTitle` / `getCurrentUrl` | yes | served from the cached body |
| `driver.findElement` / `findElements` | yes (read) | element reads parsed from cached HTML |
| `WebElement.getText` / `getAttribute` / `getTagName` | yes (read) | best-effort parse of the cached body |
| `driver.executeScript` | partial | `document.title` / `outerHTML` / `location` map to cached reads; arbitrary JS returns `null` |
| `driver.wait` (`until.titleIs/titleContains/elementLocated/urlContains`) | yes | polls the static cached page |
| `WebElement.click` / `sendKeys` / `clear` / `submit` | **partial** | no live DOM on a cached page — these are honest no-ops, never faked success |
| `By.css/id/xpath/className/name/tagName/linkText` | yes | return `{ using, value }` locators |
| `Key` constants (`ENTER`, `TAB`, `ESCAPE`, …) | yes | real selenium codepoints |

Anything that requires driving a live DOM (real clicks, typing, navigation
triggered by interaction) is **partial**: the methods exist and resolve so your
script runs, but they do not mutate a remote browser. Capture an interactive
flow once via the `unbrowse` CLI so its result is cached and resolvable.

## Attribution

This shim mirrors the public surface of
[`selenium-webdriver`](https://github.com/SeleniumHQ/selenium) (Apache-2.0). It
swaps the transport (the Unbrowse marketplace cache instead of the WebDriver
protocol); it does not vendor or replace Selenium itself.
