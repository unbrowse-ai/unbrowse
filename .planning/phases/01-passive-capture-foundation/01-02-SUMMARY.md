---
phase: 01
plan: 02
subsystem: capture
tags: [extension-observer, merge-pipeline]
metrics:
  duration_seconds: 597
  completed: 2026-04-01T10:36:52Z
---

# Phase 1 Plan 02: Extension Data Collection + Merge Pipeline Summary

Wire kuri extension observer into capture pipeline. Unify JS interceptor, HAR, and extension data via mergePassiveCaptureData.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add collectExtensionRequests function | 87a7a4a | src/capture/index.ts |
| 2 | Add mergePassiveCaptureData and wire into captureSession | 78daaff | src/capture/index.ts |
| 3 | End-to-end verification | (verification only) | -- |

## Changes Made

### Task 1: Add collectExtensionRequests function

2 additions to src/capture/index.ts (36 lines):

1. ExtensionEntry interface (line 149): Typed interface for extension-observed network entries.

2. collectExtensionRequests function (line 564): Queries window.__kuri._networkLog via kuri.evaluate, drains the log, parses entries. Returns [] gracefully when relay not wired.

### Task 2: Add mergePassiveCaptureData and wire merge pipeline

Major refactor of src/capture/index.ts (89 insertions, 54 deletions):

1. mergePassiveCaptureData function (line 482): Four-priority merge with URL dedup.
   Priority 1: JS-intercepted (have bodies). Priority 2: HAR (supplemented with responseBodies).
   Priority 3: Extension (URL+headers only). Priority 4: responseBodies-only.

2. Wiring: Extension collection at line 885. Old three-pass synthesis replaced with single merge call at line 964.

3. Debug logging: Pre-merge counts (line 948) and post-merge unified count (line 965).

### Task 3: End-to-end verification

GitHub Search: Capture succeeded (30.7s). api.github.com/search/repositories discovered, score 462.2. Response body present.

lu.ma: Capture completed (13.9s) but no_endpoints. Expected for auth-gated SPA sites.

## Deviations from Plan

None - plan executed exactly as written.

## Verification

- [x] collectExtensionRequests reads extension network data via kuri.evaluate
- [x] mergePassiveCaptureData combines JS interceptor + HAR + extension with deduplication
- [x] Extension collection is non-blocking, gracefully returns [] if relay not wired
- [x] Merged data reaches extractEndpoints and produces EndpointDescriptor[]
- [x] At least one merged request carries non-empty response_body for API call
- [x] No regression in existing capture flow for GitHub search

## Self-Check: PASSED

- FOUND: src/capture/index.ts (modified file)
- FOUND: 87a7a4a (task 1 commit)
- FOUND: 78daaff (task 2 commit)
- FOUND: 01-02-SUMMARY.md (this file)
