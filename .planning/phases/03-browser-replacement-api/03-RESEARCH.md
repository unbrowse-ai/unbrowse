# Phase 3: Browser Replacement API - Research

**Researched:** 2026-04-01
**Domain:** Drop-in browser replacement for AI agents — Playwright/Puppeteer API compatibility via kuri
**Confidence:** HIGH

---

## Summary

Phase 3 creates a `Browser`/`Page` API that mirrors Playwright's interface so agents can swap `import { chromium } from 'playwright'` for `import { Browser } from 'unbrowse'`. Under the hood, `page.goto(url)` first checks the skill cache (Phase 2) — if a cached skill exists, it resolves via the skill execution path without opening a browser. On cache miss, it transparently launches kuri, passively captures traffic, and returns the page result. The agent is unaware which path was taken.

BROWSER-02 (UI actions: click, fill, submit) is externally blocked on Rach delivering the kuri UI action hook. Phase 3 designs the API surface for BROWSER-02 now and gates the implementation behind feature detection — `kuri.snapshot()` success determines whether ref-based actions are available or evaluate-based fallbacks are used.

**Key kuri client methods** (verified in `src/kuri/client.ts`, READ ONLY):
- `kuri.start()` / `kuri.stop()` — lifecycle
- `kuri.newTab()` / `kuri.closeTab()` — tab management
- `kuri.navigate(tabId, url)` — navigation
- `kuri.evaluate(tabId, script)` — JS evaluation
- `kuri.getPageHtml(tabId)` — page content
- `kuri.getCurrentUrl(tabId)` — current URL
- `kuri.screenshot(tabId)` — screenshots
- `kuri.scriptInject(tabId, script)` — persistent injection (Phase 1)
- `kuri.domQuery(tabId, selector)` — DOM query (BROWSER-02, may not exist yet)
- `kuri.snapshot(tabId)` — accessibility snapshot (BROWSER-02 feature detection)

**Resolve integration:** `page.goto()` calls `resolveAndExecute(intent, {}, { url })` — the full 7-layer cache cascade from Phase 2. On cache hit, the skill result is stored on the Page instance. On miss, falls through to live capture via `captureSession`.

---

## Standard Stack

| Library / API | Location | Purpose |
|---|---|---|
| `resolveAndExecute` | `src/orchestrator/index.ts:1825` | Full resolve cascade — cache → marketplace → capture |
| `captureSession` | `src/capture/index.ts` | Live browser capture with passive interception |
| `kuri.*` | `src/kuri/client.ts` | Browser engine primitives (READ ONLY) |
| `queueBackgroundIndex` | `src/indexer/index.ts` | Background skill indexing (Phase 2) |
| `extractEndpoints` | `src/reverse-engineer/index.ts:590` | Traffic → endpoints |

---

## Architecture

```
Agent code:
  const browser = await Browser.launch()
  const page = await browser.newPage()
  const response = await page.goto("https://example.com/search?q=test")
  const data = await response.json()
  // OR: const html = await page.content()

Under the hood (page.goto):
  1. resolveAndExecute(intent, {}, { url })
     → cache hit?  → return skill result as UnbrowseResponse
     → cache miss? → captureSession(url) → return page result
                     → queueBackgroundIndex (next visit hits cache)

  2. page.click(selector)  [BROWSER-02]
     → kuri.snapshot(tabId) succeeds? → ref-based actions
     → fails? → evaluate-based fallback (document.querySelector.click())
```

**Research date:** 2026-04-01
