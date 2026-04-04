---
phase: "04"
plan: "01"
subsystem: "graph"
tags: [graph, types, planner, persistence]
dependency-graph:
  requires: []
  provides: [typed-edges, graph-persistence]
  affects: [graph/index.ts, graph/planner.ts, types/skill.ts]
tech-stack:
  added: []
  patterns: [edge-classification, pagination-detection]
key-files:
  created: []
  modified:
    - src/types/skill.ts
    - src/graph/index.ts
    - src/graph/planner.ts
decisions:
  - Pagination keys detected via static set + regex patterns for cursor/page suffixes
  - parent_child edges classified by list->detail action_kind + matching resource_kind
  - auth edges classified by source action_kind matching auth patterns + target.auth_required
  - ensureSkillOperationGraph now prioritizes persisted graph over rebuilding
metrics:
  duration: "2m 1s"
  completed: "2026-04-01T11:54:08Z"
  tasks-completed: 2
  tasks-total: 2
---

# Phase 4 Plan 1: Dependency Graph Construction with Typed Edges Summary

Typed edge classification (parent_child, pagination, auth) for the operation graph, with pagination self-edges and persisted-graph-first resolution.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Extend types and graph builder | 289b07d | src/types/skill.ts, src/graph/index.ts |
| 2 | Update planner | 289b07d | src/graph/planner.ts |

## Changes Made

### Task 1: Extend types and graph builder

- Extended `SkillOperationEdge.kind` union type with `parent_child`, `pagination`, `auth`
- Added `PAGINATION_KEYS` set and `isPaginationBindingKey()` detector covering cursor, page, offset, and pattern-based keys
- Added `classifyEdgeKind()` function that classifies edges based on action_kind semantics:
  - Self-referencing pagination bindings become `pagination` edges
  - list/search -> detail/fetch with matching resource_kind become `parent_child` edges
  - Edges to auth-required targets from auth-like sources become `auth` edges
  - Everything else remains `dependency`
- Modified `buildSkillOperationGraph` to allow self-edges when the binding key is a pagination key
- Fixed `ensureSkillOperationGraph` to check for a persisted `operation_graph` first, only falling back to rebuilding from endpoints

### Task 2: Update planner

- Updated all 3 edge traversal filters in `buildExecutionPlan` to also follow `parent_child` and `auth` edges (not just `dependency`)
- Replaced the `upsertDagEdgesFromOperationGraph` no-op stub with a real implementation that merges new edges into the existing graph by `edge_id`, preserving existing edges and updating the `generated_at` timestamp

## Decisions Made

1. Pagination keys use a static set of 13 common keys plus regex patterns for `next_`/`prev_`/`previous_` prefixes and `_cursor` suffix
2. `parent_child` classification requires both source and target to share the same non-generic `resource_kind`
3. `auth` edge classification requires `target.auth_required === true` and source action_kind matching auth/login/token/session/oauth
4. The planner now traverses `parent_child` and `auth` edges during topological sort, giving the DAG advisor visibility into these relationships

## Deviations from Plan

None -- plan executed exactly as written.

## Verification

```
bun build src/graph/index.ts --no-bundle  # OK, no errors
bun build src/graph/planner.ts --no-bundle  # OK, no errors
```
