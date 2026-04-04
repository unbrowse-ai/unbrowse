# Phase 2: Background Indexing and Cache-First Resolution - Research

**Researched:** 2026-04-01
**Domain:** Background skill indexing, local skill cache, resolve cascade optimization
**Confidence:** HIGH

---

## Summary

Phase 2 decouples the synchronous reverse-engineering pipeline from the agent's navigation path and introduces a cache-first resolution loop. Today, `executeBrowserCapture` in `src/execution/index.ts` runs the entire pipeline synchronously: `captureSession` → `extractEndpoints` → `buildSkillOperationGraph` → `validateManifest` (remote) → `publishSkill` (remote) → `cachePublishedSkill`. The agent blocks for the full duration (~15-30s). Phase 2 splits this into a fast synchronous path (capture + endpoint extraction + local cache write) and a deferred background path (graph building + marketplace publish).

The resolve cascade in `resolveAndExecute` (`src/orchestrator/index.ts`) already checks 5 cache layers before falling through to marketplace and live capture. The missing piece is **cache population from the capture path**: currently, the local skill snapshot cache (`~/.unbrowse/skill-snapshots/`) and the domain skill cache (`~/.unbrowse/domain-skill-cache.json`) are only populated AFTER a successful auto-exec in the resolve path (via `promoteLearnedSkill`). Phase 2 adds a background indexer that writes to these caches immediately after capture, so a second `resolve` call finds the cached skill without hitting marketplace or launching kuri.

**Primary recommendation:** Create a background indexing queue (`src/indexer/index.ts`) that accepts captured traffic and processes it asynchronously. Wire it into `executeBrowserCapture` so the agent gets the capture result immediately while indexing continues in the background. The existing resolve cascade (`findBestLocalDomainSnapshot` at line 2753 and 2843) already reads from `SKILL_SNAPSHOT_DIR` — no changes needed to the resolve lookup path.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PASSIVE-03 | Background indexing — reverse-engineer endpoints from passively observed traffic without blocking navigation | Supported by: `extractEndpoints` is CPU-only (~50ms); the blocking calls are `validateManifest` and `publishSkill` (remote API, 500-2000ms each). Moving these to a fire-and-forget background queue eliminates the block. Local cache write (`writeSkillSnapshot`) is ~1ms. |
| PASSIVE-04 | Cache-first resolution — second call to any site hits local cache or marketplace, no re-capture needed | Supported by: `resolveAndExecute` already checks `routeResultCache` → `skillRouteCache` → `domainSkillCache` → `findBestLocalDomainSnapshot` → marketplace → live capture. Background indexer writes to `writeSkillSnapshot` + `domainSkillCache`, which `findBestLocalDomainSnapshot` reads. No resolve-side changes needed. |
</phase_requirements>

---

## Standard Stack

### Core (verified against source files — all HIGH confidence)

| Library / API | Version / Location | Purpose | Why Standard |
|---|---|---|---|
| `extractEndpoints` | `src/reverse-engineer/index.ts:590` | Converts `RawRequest[]` to `EndpointDescriptor[]` | Existing, load-bearing; CPU-only, ~50ms; no async dependencies |
| `buildSkillOperationGraph` | `src/graph/index.ts:675` | Builds semantic dependency graph from endpoints | Existing; CPU-only; called in `executeBrowserCapture` at L1256/L1372 |
| `prepareLearnedEndpoints` | `src/execution/index.ts:56` | Normalizes endpoints, resolves semantic descriptions | Existing; called before skill creation at L1349 |
| `writeSkillSnapshot` | `src/orchestrator/index.ts:178` | Writes skill JSON to `~/.unbrowse/skill-snapshots/{hash}.json` | Existing; ~1ms file write; used by `promoteLearnedSkill` |
| `findBestLocalDomainSnapshot` | `src/orchestrator/index.ts:254` | Scans skill snapshot dir for best domain+intent match | Existing; already in resolve cascade at L2753 and L2843 |
| `domainSkillCache` + `persistDomainCache` | `src/orchestrator/index.ts:78-87` | In-memory Map with 7-day TTL, persisted to disk | Existing; already in resolve cascade at L2727-2751 |
| `skillRouteCache` + `persistRouteCache` | `src/orchestrator/index.ts:69-116` | In-memory Map with 24h TTL, persisted to disk | Existing; already in resolve cascade at L2674-2724 |
| `queuePassiveSkillPublish` | `src/orchestrator/passive-publish.ts:45` | Fire-and-forget marketplace publish with parity check | Existing; pattern for background async work |
| `validateManifest` | `src/client/index.ts:723` | Remote API call to validate skill manifest | Existing; blocking (~500ms); should be deferred |
| `publishSkill` | `src/client/index.ts:534` | Remote API call to publish skill to marketplace | Existing; blocking (~1000ms); should be deferred |
| `cachePublishedSkill` | `src/client/index.ts:426` | Writes skill to local skill cache dir | Existing; fast local file write |
| `findExistingSkillForDomain` | `src/client/index.ts:460` | Finds previously cached skill for domain reuse | Existing; used in `executeBrowserCapture` at L1329 |
| `mergeEndpoints` | `src/marketplace/index.ts:58` | Merges new endpoints into existing skill's endpoints | Existing; deduplicates by URL template |
| `getDomainReuseKey` | `src/orchestrator/index.ts:317` | Normalizes domain for cache key (strips port, www, etc.) | Existing; used by all cache layers |

### Supporting

| Library / API | Version / Location | Purpose | When to Use |
|---|---|---|---|
| `generateLocalDescription` | `src/orchestrator/index.ts:3534` | Heuristic endpoint description for BM25 ranking | Called in resolve after live capture; also needed in background indexer |
| `ensureSkillOperationGraph` | `src/graph/index.ts:726` | Builds graph only if missing | Use instead of `buildSkillOperationGraph` for idempotency |
| `scopedCacheKey` | `src/orchestrator/index.ts:163` | Builds scoped cache key `{scope}:{key}` | Needed to write to caches in the same format resolve reads |
| `buildResolveCacheKey` | `src/orchestrator/index.ts:367` | Builds resolve cache key from domain+intent+url | Needed for proper cache key construction |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Custom background queue | `setImmediate` / microtask | `setImmediate` is too granular; we need per-domain dedup and in-flight tracking. A Map-based queue (like `queuePassiveSkillPublish`) is the right pattern. |
| Separate worker thread | Main thread async | Worker threads add IPC overhead and require serializing SkillManifest. Async processing on the main event loop is sufficient since `extractEndpoints` is <100ms CPU time. |
| SQLite cache | JSON file snapshots | JSON files in `~/.unbrowse/skill-snapshots/` are already the cache substrate. Adding SQLite would add a dependency for no gain at this scale (<1000 skills). |

**Installation:** No new packages required. All dependencies are existing modules.

---

## Architecture Patterns

### Current executeBrowserCapture Flow (what exists, read from source)

```
executeBrowserCapture(skill, params)
  captureSession(url, authHeaders, cookies, intent)        // BLOCKING: browser launch + navigate + wait (~8-20s)
  extractEndpoints(captured.requests, ...)                  // CPU-only (~50ms)
  buildSkillOperationGraph(endpoints)                       // CPU-only (~20ms)
  validateManifest(draft)                                   // BLOCKING: remote API (~500ms)
  publishSkill(draft)                                       // BLOCKING: remote API (~1000ms)
  cachePublishedSkill(learned)                              // local file write (~1ms)
  return { trace, result, learned_skill }
```

**Problems:** Agent blocks for validateManifest + publishSkill (1.5s+ of remote calls). Skill snapshot cache is NOT populated here — only populated later in `promoteLearnedSkill` if auto-exec succeeds. If auto-exec fails, the skill is never cached locally.

### Target Flow (Phase 2)

```
executeBrowserCapture(skill, params)
  captureSession(url, authHeaders, cookies, intent)        // BLOCKING: same as today
  extractEndpoints(captured.requests, ...)                  // CPU-only, same as today
  prepareLearnedEndpoints(endpoints, intent, domain)        // CPU-only, same as today
  
  // NEW: Write to local cache IMMEDIATELY (before publish)
  writeSkillSnapshot(cacheKey, localDraft)                  // ~1ms
  updateDomainSkillCache(domain, localDraft)                // ~1ms
  
  // NEW: Queue heavy work for background
  queueBackgroundIndex({
    skill: localDraft,
    domain, intent, contextUrl,
  })
  
  return { trace, result, learned_skill: localDraft }       // Return immediately

// BACKGROUND (non-blocking):
backgroundIndexer processes queue:
  buildSkillOperationGraph(endpoints)                       // CPU (~20ms)
  generateLocalDescription(endpoint) for each endpoint      // CPU (~5ms)
  validateManifest(draft)                                   // Remote (~500ms)
  publishSkill(draft)                                       // Remote (~1000ms)  
  cachePublishedSkill(published)                            // Local (~1ms)
```

**Key change:** Local cache is populated synchronously (1-2ms). Remote calls are deferred. Second resolve finds the cached skill via `findBestLocalDomainSnapshot`.

### Resolve Cascade (already exists — no changes needed)

```
resolveAndExecute(intent, params, context)
  1. routeResultCache          — in-memory, exact match           ← existing
  2. skillRouteCache           — persisted, intent+url → skillId  ← existing
  3. domainSkillCache          — persisted, domain → skillId      ← existing, NOW populated by background indexer
  4. findBestLocalDomainSnapshot — scan skill-snapshots/ dir      ← existing, NOW populated by background indexer
  5. Marketplace search        — remote vector search             ← existing
  6. First-pass browser action — lightweight 8s attempt           ← existing
  7. Live capture              — full browser capture             ← existing (last resort)
```

### Recommended Project Structure

```
src/indexer/index.ts          NEW: background indexing queue
                              - queueBackgroundIndex()
                              - BackgroundIndexQueue class
                              - per-domain dedup Map
                              - processing: graph + publish + cache

src/execution/index.ts        MODIFY: executeBrowserCapture
                              - write local cache before publish
                              - queue background indexer
                              - remove synchronous publishSkill
                              - remove synchronous validateManifest

src/orchestrator/index.ts     MODIFY (minimal): export cache helpers
                              - export writeSkillSnapshot (currently module-private)
                              - export domainSkillCache helpers
                              - export persistDomainCache
                              - no resolve cascade changes needed
```

### Pattern 1: Background Indexing Queue (PASSIVE-03)

**What:** A fire-and-forget queue that accepts skill drafts and processes them asynchronously — graph building, marketplace validation, and publishing.

**Source pattern:** `src/orchestrator/passive-publish.ts:25-117` — same Map-based dedup + Promise pattern

```typescript
// src/indexer/index.ts
const indexInFlight = new Map<string, Promise<void>>();

export function queueBackgroundIndex(job: {
  skill: SkillManifest;
  domain: string;
  intent: string;
  contextUrl?: string;
  clientScope?: string;
}): void {
  const key = job.domain;
  if (indexInFlight.has(key)) return; // dedup: one job per domain

  const work = (async () => {
    // 1. Build operation graph (CPU, ~20ms)
    const graph = buildSkillOperationGraph(job.skill.endpoints);
    job.skill.operation_graph = graph;

    // 2. Generate local descriptions for BM25 ranking
    for (const ep of job.skill.endpoints) {
      if (!ep.description) ep.description = generateLocalDescription(ep);
    }

    // 3. Validate + publish to marketplace (remote, ~1.5s)
    const publishable = job.skill.endpoints.filter(ep => ep.method !== "WS");
    if (publishable.length > 0) {
      const { operation_graph: _g, ...base } = job.skill;
      const draft = { ...base, endpoints: publishable };
      const validation = await validateManifest({ ...draft, skill_id: "__validate__" });
      if (validation.valid) {
        const published = await publishSkill(draft);
        cachePublishedSkill({
          ...published,
          endpoints: job.skill.endpoints,
          operation_graph: graph,
          ...(job.skill.auth_profile_ref ? { auth_profile_ref: job.skill.auth_profile_ref } : {}),
        }, job.clientScope);
      }
    }
  })()
    .catch(err => console.error(`[background-index] failed for ${key}: ${(err as Error).message}`))
    .finally(() => indexInFlight.delete(key));

  indexInFlight.set(key, work);
}
```

### Pattern 2: Early Local Cache Write (PASSIVE-04)

**What:** Write the skill to `SKILL_SNAPSHOT_DIR` and `domainSkillCache` BEFORE marketplace publish, so the second resolve finds it immediately.

**Source:** `promoteLearnedSkill` at `src/orchestrator/index.ts:371-399` — already does exactly this but is only called after auto-exec succeeds.

```typescript
// In executeBrowserCapture, AFTER extractEndpoints, BEFORE publishSkill:
// Write local cache immediately so second resolve finds the skill
const cacheKey = buildResolveCacheKey(domain, intent, url);
const scopedKey = scopedCacheKey(clientScope, cacheKey);
writeSkillSnapshot(scopedKey, localDraft);
const domainKey = getDomainReuseKey(url ?? domain);
if (domainKey) {
  domainSkillCache.set(domainKey, {
    skillId: localDraft.skill_id,
    localSkillPath: snapshotPathForCacheKey(scopedKey),
    ts: Date.now(),
  });
  persistDomainCache();
}
```

### Anti-Patterns to Avoid

- **Moving `extractEndpoints` to background**: `extractEndpoints` is fast (~50ms) and needed for the skill to be useful in the response. Keep it synchronous.
- **Editing `src/kuri/client.ts`**: CLAUDE.md explicit constraint.
- **Worker threads for background indexing**: Overkill. The CPU-bound work (`extractEndpoints`, `buildSkillOperationGraph`) totals <100ms. Main-thread async is sufficient.
- **Removing marketplace publish entirely**: Phase 5 needs marketplace-published skills. Keep publish but defer it to background.
- **Writing to `skillRouteCache` from the background indexer**: `skillRouteCache` maps `intent+url → skillId` and is meant for the exact resolve path. The domain-level cache and snapshot dir are the correct targets for background indexing (they're intent-agnostic).
- **Blocking on graph building in the response path**: `buildSkillOperationGraph` creates the operation graph for DAG planning. It's only needed for the `available_operations` field in the resolve response. Since `extractEndpoints` already produces endpoints, the resolve response can list endpoints without the graph. Build graph in background.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Background async queue | Custom event emitter | Map<string, Promise> pattern from `passive-publish.ts` | Proven pattern, handles dedup and error isolation |
| Skill manifest creation | New skill builder | Existing `localDraft` construction in `executeBrowserCapture` L1358-1375 | Already handles all fields correctly |
| Cache key generation | New hashing scheme | `buildResolveCacheKey` + `scopedCacheKey` | Already used by resolve cascade |
| Domain normalization | Manual hostname parsing | `getDomainReuseKey` | Handles ports, www, IP addresses correctly |
| Endpoint merging | Manual dedup | `mergeEndpoints` from `src/marketplace/index.ts:58` | Already handles URL template matching |

---

## Common Pitfalls

### Pitfall 1: Skill Without Operation Graph Breaks DAG Planning

**What goes wrong:** A skill written to cache before `buildSkillOperationGraph` runs has `operation_graph: undefined`. When the resolve cascade finds it and tries to build the `available_operations` response, `getSkillChunk` at `src/graph/index.ts:827` calls `ensureSkillOperationGraph` which builds it on-the-fly.

**Why it happens:** The background indexer hasn't finished building the graph yet when the second resolve hits the cache.

**How to avoid:** `ensureSkillOperationGraph` at L726 already handles this case — it builds the graph if missing and attaches it. No defensive code needed; just don't assume `operation_graph` is present.

**Warning signs:** None visible to the agent. The resolve response will have `available_operations` regardless.

### Pitfall 2: Race Between Background Publish and Second Resolve

**What goes wrong:** Background indexer calls `publishSkill` which returns a new `skill_id` from the backend. Meanwhile, the local cache has the old `skill_id` (from `nanoid()`). The `domainSkillCache` entry points to a local-only skill_id that doesn't exist in the marketplace.

**Why it happens:** `publishSkill` may reassign `skill_id` (it uses `findExistingSkillForDomain` server-side).

**How to avoid:** This is already handled: `findBestLocalDomainSnapshot` reads the skill manifest from disk (which has the local skill_id). The resolve cascade uses the local snapshot directly — it doesn't need the marketplace skill_id to work. When the background publish completes, it calls `cachePublishedSkill` which updates the local cache with the marketplace skill_id.

**Warning signs:** `skill_id` in resolve response doesn't match marketplace. Harmless — reconciled on next publish.

### Pitfall 3: Double Indexing from Concurrent Resolves

**What goes wrong:** Two concurrent `resolve` calls for the same domain both trigger live capture. Both write to the background indexer queue. Two publish calls race.

**Why it happens:** `captureInFlight` dedup (L3136) only applies when the first capture hasn't completed. If both complete, both trigger indexing.

**How to avoid:** The indexer queue uses per-domain dedup (`indexInFlight.has(key)` — skips if a job is already running). Additionally, `mergeEndpoints` in `publishSkill` handles idempotent merging server-side.

**Warning signs:** `[background-index] skipped for {domain}: already in flight` log.

### Pitfall 4: Local Cache Stale After Background Publish Updates Skill

**What goes wrong:** Local snapshot has version A of the skill. Background publish succeeds and `cachePublishedSkill` writes version B (with backend descriptions). But the snapshot dir still has version A. Second resolve reads version A from snapshot.

**Why it happens:** `writeSkillSnapshot` and `cachePublishedSkill` write to different locations (`~/.unbrowse/skill-snapshots/` vs `~/.unbrowse/skills/`).

**How to avoid:** After background publish completes, update the snapshot too. Call `writeSkillSnapshot` again with the published skill. The `pickPreferredSkillSnapshot` function at L214 already handles multiple snapshots for the same skill_id by picking the one with the highest score.

**Warning signs:** Endpoints show heuristic descriptions instead of LLM descriptions after the first cache hit. Harmless — will resolve after cache expires or next capture.

### Pitfall 5: `promoteLearnedSkill` Called on Export-Only Functions

**What goes wrong:** `writeSkillSnapshot`, `domainSkillCache`, and `persistDomainCache` are module-private in `src/orchestrator/index.ts`. The background indexer in `src/indexer/index.ts` can't access them.

**Why it happens:** These functions were designed for use within the orchestrator only.

**How to avoid:** Export the needed helpers from `src/orchestrator/index.ts`: `writeSkillSnapshot`, `persistDomainCache`, `domainSkillCache`, `getDomainReuseKey`, `scopedCacheKey`, `buildResolveCacheKey`, `snapshotPathForCacheKey`. Alternatively, extract cache logic into a shared module. Prefer exports — minimal change, no refactoring risk.

**Warning signs:** TypeScript compilation errors on import.

---

## Code Examples

### Background indexing queue (core module)

```typescript
// src/indexer/index.ts
import { buildSkillOperationGraph, ensureSkillOperationGraph } from "../graph/index.js";
import { validateManifest, publishSkill, cachePublishedSkill } from "../client/index.js";
import {
  writeSkillSnapshot,
  domainSkillCache,
  persistDomainCache,
  getDomainReuseKey,
  scopedCacheKey,
  snapshotPathForCacheKey,
} from "../orchestrator/index.js";
import type { SkillManifest } from "../types/index.js";

const indexInFlight = new Map<string, Promise<void>>();

export interface BackgroundIndexJob {
  skill: SkillManifest;
  domain: string;
  intent: string;
  contextUrl?: string;
  clientScope?: string;
  cacheKey: string;
}

export function queueBackgroundIndex(job: BackgroundIndexJob): void {
  const key = job.domain;
  if (indexInFlight.has(key)) return;

  const work = processIndexJob(job)
    .catch(err => console.error(`[background-index] failed for ${key}: ${(err as Error).message}`))
    .finally(() => indexInFlight.delete(key));

  indexInFlight.set(key, work);
}

async function processIndexJob(job: BackgroundIndexJob): Promise<void> {
  const { skill, domain, clientScope } = job;
  const scopedKey = scopedCacheKey(clientScope ?? "global", job.cacheKey);

  // 1. Build operation graph
  skill.operation_graph = buildSkillOperationGraph(skill.endpoints);

  // 2. Update local snapshot with graph
  writeSkillSnapshot(scopedKey, skill);

  // 3. Validate + publish to marketplace
  const publishable = skill.endpoints.filter(ep => ep.method !== "WS");
  if (publishable.length === 0) return;

  const { operation_graph: _g, ...base } = skill;
  const draft: SkillManifest = { ...base, endpoints: publishable };
  const validation = await validateManifest({ ...draft, skill_id: "__validate__" });
  if (!validation.valid) {
    console.warn(`[background-index] validation failed for ${domain}: ${validation.hardErrors.join("; ")}`);
    return;
  }

  const published = await publishSkill(draft);
  const merged: SkillManifest = {
    ...published,
    endpoints: skill.endpoints,
    operation_graph: skill.operation_graph,
    ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
  };
  cachePublishedSkill(merged, clientScope);

  // Update snapshot with published version (has backend descriptions)
  writeSkillSnapshot(scopedKey, merged);
  console.log(`[background-index] completed for ${domain} → ${published.skill_id}`);
}

export function isIndexingInFlight(domain: string): boolean {
  return indexInFlight.has(domain);
}

export function resetIndexQueueForTests(): void {
  indexInFlight.clear();
}
```

### Modified executeBrowserCapture — early cache write + deferred publish

```typescript
// In src/execution/index.ts, replacing lines ~1358-1390 of executeBrowserCapture:

// Build local skill draft (same as today)
const localDraft: SkillManifest = {
  skill_id: existingSkill?.skill_id ?? nanoid(),
  version: "1.0.0",
  schema_version: "1",
  lifecycle: "active",
  execution_type: "http",
  created_at: existingSkill?.created_at ?? new Date().toISOString(),
  updated_at: new Date().toISOString(),
  name: domain,
  intent_signature: intent,
  domain,
  description: `API skill for ${domain}`,
  owner_type: "agent",
  endpoints: localEndpoints,
  // operation_graph: built in background
  intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
  ...(auth_profile_ref ? { auth_profile_ref } : {}),
};

// Generate local descriptions immediately so BM25 works on first cache hit
for (const ep of localDraft.endpoints) {
  if (!ep.description) ep.description = generateLocalDescription(ep);
}

// NEW: Write local cache IMMEDIATELY (1-2ms)
const cacheKey = buildResolveCacheKey(domain, intent, url);
const scopedKey = scopedCacheKey(options?.client_scope ?? "global", cacheKey);
writeSkillSnapshot(scopedKey, localDraft);
const domainKey = getDomainReuseKey(url ?? domain);
if (domainKey) {
  domainSkillCache.set(domainKey, {
    skillId: localDraft.skill_id,
    localSkillPath: snapshotPathForCacheKey(scopedKey),
    ts: Date.now(),
  });
  persistDomainCache();
}

// NEW: Queue heavy work for background (graph + validate + publish)
queueBackgroundIndex({
  skill: localDraft,
  domain,
  intent,
  contextUrl: url,
  clientScope: options?.client_scope,
  cacheKey,
});

// Return immediately — no blocking on publish
let learned: SkillManifest = localDraft;
try { cachePublishedSkill(localDraft, options?.client_scope); } catch { /* best-effort */ }
```

---

## State of the Art

| Old Approach | Current Approach | Notes | Impact |
|---|---|---|---|
| Synchronous publish in capture path | Synchronous publish blocks agent 1.5s+ | `validateManifest` + `publishSkill` = 2 remote API calls | Agent latency reduced by ~1.5s per capture |
| No local cache write until auto-exec | Local cache only populated after successful auto-exec | `promoteLearnedSkill` only called on auto-exec success | Second resolve always falls through to marketplace |
| No background indexing | N/A (Phase 2 introduces it) | — | Cache-first resolution for repeat visits |

**Deprecated/outdated after Phase 2:**
- Synchronous `validateManifest` + `publishSkill` calls in `executeBrowserCapture` (L1380-1382): moved to background queue
- Skill creation without local cache write: every capture now writes to snapshot dir immediately

---

## Open Questions

1. **Should the background indexer retry on publish failure?**
   - What we know: `publishSkill` can fail on network errors or backend downtime. The skill is already cached locally, so the agent isn't affected.
   - Recommendation: No retry in Phase 2. If publish fails, the skill remains local-only. Next `resolve` will find it in local cache. Next live capture will attempt publish again.

2. **Cache eviction policy for skill snapshots**
   - What we know: `SKILL_SNAPSHOT_DIR` grows unbounded. Each snapshot is ~5-50KB. At 1000 sites visited, that's 5-50MB.
   - Recommendation: Out of scope for Phase 2. Add LRU eviction in a future phase when the snapshot count warrants it.

3. **Should `extractEndpoints` run in the background too?**
   - What we know: `extractEndpoints` is ~50ms CPU time. It's needed for the `learned_skill` in the response.
   - Recommendation: Keep synchronous. The agent needs endpoints to build a useful deferral response.

---

## Sources

### Primary (HIGH confidence — verified against source files)

- `src/execution/index.ts:955-1400` — `executeBrowserCapture` full flow: capture → extract → graph → publish → cache
- `src/orchestrator/index.ts:42-176` — cache infrastructure: Maps, TTLs, persistence, cache key generation
- `src/orchestrator/index.ts:178-293` — snapshot management: `writeSkillSnapshot`, `readSkillSnapshot`, `findBestLocalDomainSnapshot`
- `src/orchestrator/index.ts:371-415` — `promoteLearnedSkill`, `cacheResolvedSkill` — cache population after auto-exec
- `src/orchestrator/index.ts:1825-3480` — `resolveAndExecute` full cascade: 7 layers from cache to live capture
- `src/orchestrator/passive-publish.ts:25-117` — `queuePassiveSkillPublish`: fire-and-forget async queue pattern
- `src/reverse-engineer/index.ts:590-857` — `extractEndpoints`: CPU-only, takes RawRequest[] → EndpointDescriptor[]
- `src/graph/index.ts:675-730` — `buildSkillOperationGraph`, `ensureSkillOperationGraph`: graph construction
- `src/client/index.ts:426-429` — `cachePublishedSkill`: local file write
- `src/client/index.ts:460-485` — `findExistingSkillForDomain`: reads from local skill cache
- `src/client/index.ts:534-538` — `publishSkill`: remote API
- `src/client/index.ts:723-726` — `validateManifest`: remote API
- `src/marketplace/index.ts:58-93` — `mergeEndpoints`: URL template dedup

### Secondary (MEDIUM confidence)

- `src/types/skill.ts:204-228` — `SkillManifest` interface: all fields verified
- `src/capture/index.ts` — `CaptureResult` type verified against `executeBrowserCapture` usage

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all verified against source files
- Architecture patterns: HIGH — derived from reading actual code paths
- Pitfalls: HIGH — derived from source code analysis
- Cache cascade: HIGH — verified 7-layer resolve flow line by line

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (orchestrator and cache infrastructure are stable)
