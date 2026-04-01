---
phase: "02"
plan: "01"
subsystem: indexer
tags: [background-indexing, cache, queue, dedup]
dependency-graph:
  requires: [orchestrator-cache-helpers, client-publish, graph-builder]
  provides: [background-index-queue]
  affects: [orchestrator-exports]
tech-stack:
  added: []
  patterns: [fire-and-forget-queue, per-domain-dedup]
key-files:
  created:
    - src/indexer/index.ts
  modified:
    - src/orchestrator/index.ts
decisions:
  - Per-domain dedup via in-memory Map (one job per domain at a time)
  - buildResolveCacheKey already exported; only 7 additions needed
metrics:
  duration: 141s
  completed: "2026-04-01T11:19:52Z"
---

# Phase 2 Plan 1: Background Indexing Queue Summary

Fire-and-forget background indexing queue with per-domain dedup that builds operation graphs, generates BM25 descriptions, validates manifests, and publishes to marketplace without blocking resolve responses.

## What Was Built

### Task 1: Export cache helpers from orchestrator
Exported 7 previously module-private functions/variables from `src/orchestrator/index.ts` so the new indexer module can share the same cache infrastructure that `resolveAndExecute` reads. `buildResolveCacheKey` was already exported, so only 7 additions were needed:
- `writeSkillSnapshot`, `domainSkillCache`, `persistDomainCache`, `getDomainReuseKey`, `scopedCacheKey`, `snapshotPathForCacheKey`, `generateLocalDescription`

### Task 2: Create background indexing module
Created `src/indexer/index.ts` with:
- `queueBackgroundIndex(job)` — non-blocking entry point, fires async processing and returns immediately
- `processIndexJob(job)` — internal pipeline: graph build, local description generation, snapshot write, manifest validation, marketplace publish, cache update
- `isIndexingInFlight(domain)` — check if a domain has a running job
- `resetIndexQueueForTests()` — test utility to clear the in-flight map
- Per-domain dedup: `indexInFlight` Map ensures only one job per domain runs at a time
- All failures caught and logged, never thrown (non-fatal by design)

### Task 3: Compilation verification
Confirmed zero TypeScript errors in both changed files. Pre-existing errors in unrelated files (api/routes, client, execution, graph/agent-augment) are out of scope.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1-3  | eaccaac | feat(02-01): add background indexing queue and export cache helpers |

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

- All 8 orchestrator exports present (7 new + 1 pre-existing)
- All 3 indexer exports present (queueBackgroundIndex, isIndexingInFlight, resetIndexQueueForTests)
- Per-domain dedup guard present (indexInFlight.has(key))
- Zero TypeScript errors in changed files

## Self-Check: PASSED

- FOUND: src/indexer/index.ts
- FOUND: src/orchestrator/index.ts
- FOUND: commit eaccaac
- FOUND: 02-01-SUMMARY.md
