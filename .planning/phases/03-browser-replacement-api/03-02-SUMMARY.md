---
phase: 03
plan: 02
title: Live capture fallback and conditional UI actions
subsystem: browser-api
tags: [browser, live-capture, fallback, ui-actions, graceful-degradation]
dependency_graph:
  requires: [03-01, orchestrator, kuri-client]
  provides: [live-capture-fallback, ui-action-degradation]
  affects: [agent-integration]
tech_stack:
  added: []
  patterns: [eager-html-fetch, evaluate-based-ui-actions, non-fatal-fallback]
key_files:
  created: []
  modified:
    - src/browser/index.ts
decisions:
  - resolveAndExecute already handles full capture pipeline; kuri fallback stays lightweight
  - Eager HTML fetch after kuri navigation for immediate content() availability
  - Body includes HTML when available from kuri fallback (was null before)
metrics:
  duration: 193s
  completed: 2026-04-01T12:00:47Z
  tasks_completed: 3
  tasks_total: 3
---

# Phase 3 Plan 02: Live Capture Fallback and Conditional UI Actions Summary

Enhanced kuri fallback in page.goto() with eager HTML fetch; verified BROWSER-02 evaluate-based UI actions have correct graceful degradation.

## What Was Built

### Task 1: Wire live capture fallback into page.goto

Analyzed the full `resolveAndExecute` pipeline (3600+ lines in orchestrator/index.ts) and determined:
- `resolveAndExecute` already handles: route cache, domain cache, local snapshots, marketplace search, first-pass browser action, and full live capture via `executeSkill` with browser-capture skill
- Background indexing + passive skill publish already happen inside the pipeline
- The kuri.navigate fallback only fires when the entire pipeline fails/throws

Instead of duplicating captureSession (which resolveAndExecute already calls internally), enhanced the kuri fallback to:
1. Eagerly fetch HTML via `kuri.getPageHtml()` after navigation so `content()` works immediately
2. Guard against kuri `"[object Object]"` return values (validate string starts with `<`)
3. Include HTML in the response body (was `null` before, now `this._html ?? null`)
4. Added detailed comments explaining the architectural rationale

**Deviation note:** Plan suggested importing `captureSession`, `extractEndpoints`, and `queueBackgroundIndex`. Investigation revealed `queueBackgroundIndex` does not exist in the codebase, and `resolveAndExecute` already runs captureSession internally as its last resort. Following the plan's own guidance: "If resolveAndExecute already captures as a last resort... the kuri.navigate fallback should be minimal."

- **Commit:** e5ce006

### Task 2: Verify BROWSER-02 UI actions have graceful degradation

Verified all three UI actions are correctly implemented from 03-01:
- `click(selector)`: Uses `kuri.evaluate` with `querySelector(sel)?.click()` -- optional chaining handles missing elements
- `fill(selector, value)`: Uses `kuri.evaluate` with IIFE that sets value and dispatches input event with bubbles:true -- guards with `if (el)` check
- `waitForSelector(selector)`: Polls via `kuri.evaluate` every 200ms with configurable timeout (default 5s); returns no-op for skill-resolved pages; handles both string "true" and boolean true from kuri

All three properly throw when no browser tab exists (skill-resolved pages). Feature detection via `kuri.snapshot` deferred until BROWSER-02 kuri hooks are delivered by Rach.

- **Commit:** e5ce006 (same commit, verification only)

### Task 3: Compilation check

- `bun build src/browser/index.ts --no-bundle` -- PASS (no errors)
- **Commit:** e5ce006

## Deviations from Plan

### [Rule 3 - Blocking] queueBackgroundIndex does not exist

- **Found during:** Task 1
- **Issue:** Plan referenced `queueBackgroundIndex` from `../indexer/index.js` and `extractEndpoints` from `../reverse-engineer/index.js` to be called in the kuri fallback. `queueBackgroundIndex` does not exist anywhere in the codebase. `extractEndpoints` exists but is called internally by the capture pipeline.
- **Fix:** Followed plan's alternative guidance -- kept kuri fallback lightweight since `resolveAndExecute` already runs the full capture + indexing pipeline internally (marketplace lookup, first-pass browser action, live capture via executeSkill, passive skill publish). No need to duplicate.
- **Files modified:** `src/browser/index.ts`
- **Commit:** e5ce006

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| resolveAndExecute handles full capture pipeline | The orchestrator already runs captureSession + indexing + marketplace publish as its last resort; duplicating in fallback would be redundant and could cause double-capture |
| Eager HTML fetch after kuri navigation | content() previously required a separate call; eager fetch ensures HTML is available immediately after goto() |
| Body includes HTML in fallback response | Agents calling `response.text()` or `response.json()` get useful data even on fallback path |

## Verification

- bun build: PASS (no errors)
- Git diff: clean, only intended changes (16 insertions, 2 deletions)

## Self-Check: PASSED

All modified files verified on disk. Commit e5ce006 verified in git log.
