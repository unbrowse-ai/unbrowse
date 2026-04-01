---
phase: 01
plan: 01
subsystem: capture
tags: [scriptInject, interceptor, CDP, passive-capture]
dependency_graph:
  requires: [kuri.scriptInject]
  provides: [persistent-interceptor-injection]
  affects: [src/capture/index.ts]
tech_stack:
  added: []
  patterns: [Page.addScriptToEvaluateOnNewDocument, version-guard-fallback]
key_files:
  modified: [src/capture/index.ts]
  created: []
decisions:
  - scriptInject called once before harStart; tracked in module-level Set to avoid re-registration
  - Fallback to kuri.evaluate if scriptInject throws (version guard for older kuri)
  - Polling loop replaced with single fallback evaluate (simpler, no timing races)
  - interceptorInjectedTabs cleaned up on tab release to prevent stale state
metrics:
  duration_seconds: 270
  completed: 2026-04-01T10:17:50Z
---

# Phase 1 Plan 01: Persistent Interceptor via scriptInject Summary

Wire kuri.scriptInject before navigation to install INTERCEPTOR_SCRIPT persistently via Page.addScriptToEvaluateOnNewDocument, eliminating the fragile 50ms polling re-injection loop.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wire scriptInject and remove polling loop | 208e27c | src/capture/index.ts |
| 2 | Smoke test scriptInject wiring | (verification only) | -- |

## Changes Made

### Task 1: Wire scriptInject and remove polling loop

**5 changes to `src/capture/index.ts`:**

1. **Module-level tracking Set** (`interceptorInjectedTabs`): Tracks which tabs have persistent interceptor installed to avoid redundant registration.

2. **scriptInject before harStart**: Calls `kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT)` wrapped in try/catch. On success, marks the tab in the tracking Set and logs `"interceptor installed via scriptInject (persistent)"`.

3. **Removed pre-navigation evaluate injection**: The old `evaluate:interceptor` line before `navigate()` is no longer needed since scriptInject persists across navigations.

4. **Removed 50ms polling re-injection loop**: The `while (Date.now() < injectDeadline && !injected)` loop (3s deadline, 50ms intervals) is replaced with a single conditional evaluate fallback that only runs if scriptInject was not available.

5. **Tab release cleanup**: `interceptorInjectedTabs.delete(tabId)` added to `releaseTabSlot()` to prevent stale entries.

### Task 2: Smoke test

Ran `bun src/cli.ts resolve --intent "search repositories" --url "https://github.com/search" --force-capture --pretty` after killing stale processes.

**Results:**
- Capture succeeded (live-capture, 28.9s capture time)
- GitHub search API endpoint discovered: `GET https://api.github.com/search/repositories?q={q}&per_page=20`
- Response schema populated with fields (total_count, incomplete_results, items array)
- Endpoint verification_status: "verified"
- No regression from previous behavior

## Deviations from Plan

None - plan executed exactly as written.

## Verification

- [x] scriptInject is called once before first navigate in captureSession
- [x] 50ms polling re-injection loop removed
- [x] Fallback to kuri.evaluate if scriptInject fails
- [x] interceptorInjectedTabs cleaned on tab release
- [x] Smoke test passes - endpoints discovered for GitHub search

## Self-Check: PASSED

- FOUND: src/capture/index.ts (modified file)
- FOUND: 208e27c (task 1 commit)
- FOUND: 01-01-SUMMARY.md (this file)
