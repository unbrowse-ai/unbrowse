---
phase: 03
plan: 01
title: Browser/Page API surface with skill-first navigation
subsystem: browser-api
tags: [browser, playwright-compat, skill-first, api-surface]
dependency_graph:
  requires: [orchestrator, kuri-client]
  provides: [browser-api, page-api, unbrowse-response]
  affects: [agent-integration]
tech_stack:
  added: []
  patterns: [skill-first-resolution, fallback-to-browser, playwright-compatible-api]
key_files:
  created:
    - src/browser/types.ts
    - src/browser/index.ts
  modified: []
decisions:
  - screenshot returns base64 string (matching kuri.screenshot) instead of Buffer
  - click/fill use evaluate fallback via kuri CDP, not kuri action endpoint
  - skill-resolved pages return no-op for waitForSelector and throw for evaluate/screenshot
metrics:
  duration: 94s
  completed: 2026-04-01T11:53:14Z
  tasks_completed: 3
  tasks_total: 3
---

# Phase 3 Plan 01: Browser/Page API Surface with Skill-First Navigation Summary

Playwright-compatible Browser/Page API where page.goto() resolves from unbrowse skill cache first, falling back to kuri browser navigation on cache miss.

## What Was Built

### Task 1: Create browser types (`src/browser/types.ts`)
- `UnbrowseResponse` class with Playwright-compatible `status()`, `headers()`, `url()`, `json()`, `text()` methods
- `GotoOptions` interface with `intent`, `timeout`, `waitUntil` fields
- `BrowserLaunchOptions` interface with `headless` and `intent` fields
- `SkillResolutionResult` interface exposing skill, trace, result, and source
- **Commit:** d4372b4

### Task 2: Implement Browser and Page classes (`src/browser/index.ts`)
- `Browser.launch(options?)` — calls `kuri.start()`, returns Browser instance
- `browser.newPage()` — calls `kuri.newTab()`, returns Page wrapping tabId
- `page.goto(url, options?)` — skill-first resolution via `resolveAndExecute`, fallback to `kuri.navigate`
- `inferIntentFromUrl(url)` — extracts search intent from URL path segments and query params
- `page.content()` — returns HTML from kuri when live, wraps skill JSON in HTML script tag when skill-resolved
- `page.url()` — returns current URL
- `page.evaluate(fn)` — delegates to `kuri.evaluate` with function-to-string conversion
- `page.screenshot()` — returns base64 PNG string via `kuri.screenshot`
- `page.click(selector)` / `page.fill(selector, value)` — evaluate-based fallbacks for BROWSER-02
- `page.waitForSelector(selector, opts?)` — polling loop with configurable timeout
- `page.$unbrowse` — accessor for raw `SkillResolutionResult` data
- `browser.close()` — closes all pages then stops kuri
- **Commit:** d4372b4

### Task 3: Verify compilation
- `bun build src/browser/index.ts --no-bundle` — PASS (no errors)
- `bunx tsc --noEmit` filtered for `src/browser` — PASS (no errors)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] screenshot return type corrected to string**
- **Found during:** Task 2
- **Issue:** Plan specified `Buffer` return type for `screenshot()`, but `kuri.screenshot()` returns a base64 string
- **Fix:** Changed return type to `Promise<string>` to match actual kuri client API
- **Files modified:** `src/browser/index.ts`
- **Commit:** d4372b4

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| screenshot returns base64 string | Matches kuri.screenshot() actual return type (string, not Buffer) |
| click/fill use evaluate fallback | BROWSER-02 kuri action hook not yet available; evaluate-based DOM manipulation works now |
| Skill-resolved pages throw on evaluate/screenshot | No browser tab exists when resolved from cache; agents should use $unbrowse for structured data |
| waitForSelector is no-op for skill-resolved pages | No DOM to query when data came from skill cache |

## Verification

- bun build: PASS
- TypeScript noEmit: PASS (no browser-related errors)

## Self-Check: PASSED

All created files verified on disk. Commit d4372b4 verified in git log.
