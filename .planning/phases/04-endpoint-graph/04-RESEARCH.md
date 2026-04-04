# Phase 4: Endpoint Graph - Research

**Researched:** 2026-04-01
**Domain:** Endpoint dependency graphs, prefetch optimization, graph persistence
**Confidence:** HIGH

---

## Summary

Phase 4 builds on the existing `src/graph/` layer to add three missing capabilities: (1) proper edge types for parent/child, pagination, and auth dependencies; (2) transparent prefetch during resolve so agents get related endpoint data in a single round-trip; and (3) fix graph persistence so `ensureSkillOperationGraph` uses the persisted `operation_graph` instead of always rebuilding.

The existing infrastructure is extensive. `buildSkillOperationGraph` (L675), `inferRequires`/`inferProvidesFromFields` (L281-388), `computeReachableEndpoints` (L779), and the types in `src/types/skill.ts`. The `src/graph/planner.ts` provides `fetchDagAdvisoryPlan` and `buildExecutionPlan` for topological ordering. The `src/capture/prefetch.ts` stub has the right API shape but incorrect matching logic.

**Key gaps to close:**

1. **Edge types are too coarse.** Current `SkillOperationEdge.kind` is `"dependency" | "hint"`. Need `"parent_child"`, `"pagination"`, `"auth"`.

2. **No pagination self-edges.** A list endpoint with cursor params has a self-referential pagination relationship. Current builder skips `source === target` comparisons (L682).

3. **Auth dependencies not persisted as edges.** `deriveAuthDependencies` in `src/auth/runtime.ts` checks at execution time but doesn't create graph edges.

4. **Prefetch logic is a stub.** `src/capture/prefetch.ts` has `getRelatedOps` but matches by `r.url.includes(edge.to_operation_id)` (L39) — compares URLs to operation IDs (incorrect).

5. **Graph rebuilt on every access.** `ensureSkillOperationGraph` (L726-730) always rebuilds when `endpoints.length > 0`, ignoring the persisted `operation_graph`.

6. **`available_endpoints` in resolve is flat.** `buildDeferral` (L2056-2070) returns from `rankEndpoints`, not graph reachability.

---

## Standard Stack

| Library / API | Location | Purpose |
|---|---|---|
| `buildSkillOperationGraph` | `src/graph/index.ts:675` | Constructs graph from endpoints |
| `inferRequires` | `src/graph/index.ts:281` | Infers input bindings from URL/query |
| `inferProvidesFromFields` | `src/graph/index.ts:300` | Infers output bindings from response schema |
| `computeReachableEndpoints` | `src/graph/index.ts:779` | BFS reachability from entry points |
| `getSkillChunk` | `src/graph/index.ts:827` | Agent-visible available operations |
| `ensureSkillOperationGraph` | `src/graph/index.ts:726` | Get or build graph (needs persistence fix) |
| `isRunnable` | `src/graph/index.ts:756` | Check if operation's bindings are satisfied |
| `SkillOperationEdge` | `src/types/skill.ts:157` | Edge type with kind, confidence |
| `src/capture/prefetch.ts` | existing | Prefetch logic (stub, needs rewrite) |
| `src/graph/planner.ts` | existing | DAG planner, execution plans, advisory boosts |
| `resolveAndExecute` | `src/orchestrator/index.ts:1825` | Resolve path where prefetch is wired |
| `isGenericBindingKey` | `src/graph/index.ts:409` | Blocklist including pagination keys — blocks cursor/page from edges |
| `upsertDagEdgesFromOperationGraph` | `src/graph/planner.ts:398` | Stub no-op, needs implementation |

---

## Architecture

### Current Graph Construction
```
buildSkillOperationGraph(endpoints)
  for each endpoint: buildOperationNode(endpoint)
  for each pair (A, B) where A != B:
    if A.provides overlaps B.requires: add edge (kind: "dependency")
  return { operations, edges, entry_operation_ids }
```

### Target (Phase 4)
```
buildSkillOperationGraph(endpoints)
  same as above, PLUS:
  - Allow self-loops for pagination keys (cursor, page, offset)
  - Classify edges: parent_child (list→detail same resource), auth, pagination
  - Generate auth edges: auth provider → auth-required endpoints
  persist via operation_graph field (already happens)
```

### Prefetch Integration
```
tryAutoExecute (after successful execution):
  graph = ensureSkillOperationGraph(skill)
  targets = getPrefetchTargets(graph, selectedEndpointId, knownBindings)
  prefetched = executePrefetch(skill, targets, params)
  return { result: { ...execResult, prefetched }, ... }
```

### Persistence Fix
```
ensureSkillOperationGraph(skill):
  if skill.operation_graph has operations → return it (persisted)
  else → buildSkillOperationGraph(skill.endpoints) (rebuild)
```

**Research date:** 2026-04-01
