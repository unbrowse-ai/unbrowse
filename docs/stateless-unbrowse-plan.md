# Stateless Unbrowse — Disk-Backed Index Queue

**Status:** Draft / Phase 1 not started
**Owner:** Lewis
**Goal:** Eliminate the "long-lived unbrowse server" failure mode by moving the only piece of in-process state that requires persistence (the background index queue) onto disk, so any `unbrowse` invocation is short-lived and crash-resilient.

---

## Context

Today the unbrowse MCP/HTTP server is long-lived because the **background index queue** in `src/indexer/index.ts` holds in-memory state across calls:

```ts
indexInFlight:  Map<domain, Promise>                // running jobs
pendingIndexJobs: Map<domain, BackgroundIndexJob>   // coalesced waiters
backgroundIndexProcessor                            // pluggable (tests inject)
```

If the server exits, in-flight enrichment + marketplace publish is lost. This is the root cause of the "stale server" footgun called out in `CLAUDE.md` as the #1 source of "works from source, broken from package".

Kuri (the Zig CDP broker) is already a separate daemon and holds all browser state (tabs, CDP, cookies, profiles). Unbrowse the intelligence layer only needs to be alive long enough to handle one request — *if* the index queue lives on disk instead of in memory.

## Non-goals (this slice)

- Do **not** move enrichment into Kuri (breaks the "Kuri is the dumb fast broker, unbrowse is the intelligence layer" split documented in `CLAUDE.md`).
- Do **not** change the MCP server lifecycle in Phase 1. That's Phase 2, after the queue is on disk.
- Do **not** change `src/kuri/client.ts` (forbidden by `CLAUDE.md`).

---

## Current state — call sites

```
src/indexer/index.ts:165    export function queueBackgroundIndex(job)
src/indexer/index.ts:184      → self-replay on coalesce
src/indexer/index.ts:491    export function drainPendingIndexJobs()    // tests + shutdown
src/indexer/index.ts:486    export function isIndexingInFlight()
src/indexer/index.ts:510    export function setBackgroundIndexProcessorForTests()

callers:
  src/browser/index.ts:129               passive capture on browse close
  src/orchestrator/browser-agent.ts:357  agent-driven session close
  src/api/routes.ts:216,2182,2306        HTTP capture endpoints
  src/execution/index.ts:1654            post-execute enrichment
```

API surface to preserve: `queueBackgroundIndex`, `drainPendingIndexJobs`, `isIndexingInFlight`, `setBackgroundIndexProcessorForTests`, `mergeBackgroundIndexJobs`.

---

## Phase 1 — disk-backed queue

### Design

**Queue dir:** `~/.unbrowse/queue/`
**Job file:** `<domain>.<ts>-<rand>.json` (sortable by ts; rand prevents collisions)
**Lock file:** `<domain>.lock` (advisory `flock`, per-domain serialisation)
**Worker:** `unbrowse __drain-queue` — hidden CLI verb, short-lived

### Job file shape

```json
{
  "version": 1,
  "domain": "example.com",
  "queuedAt": 1715000000000,
  "attempts": 0,
  "job": { /* BackgroundIndexJob payload */ }
}
```

### queueBackgroundIndex behaviour

```
1. Write job file atomically (write to .tmp, rename).
2. If inline mode (env UNBROWSE_INLINE_INDEX=1 or test processor set):
     run backgroundIndexProcessor synchronously, delete file, return.
3. Else:
     coalesce: if another job file for the same domain exists & queuedAt < 2s ago,
       merge via mergeBackgroundIndexJobs and overwrite the older file.
     spawn detached worker if no worker heartbeat within last 2s.
       child: spawn('unbrowse', ['__drain-queue'], { detached: true, stdio: 'ignore' }).unref()
```

### Worker (`__drain-queue`)

```
loop:
  list ~/.unbrowse/queue/*.json sorted by queuedAt
  for each file:
    try flock(domain.lock, non-blocking)
    if lock held → skip
    read job, increment attempts, write back
    if attempts > MAX_ATTEMPTS (3) → move to ~/.unbrowse/queue/dead/
    else:
      call backgroundIndexProcessor(job)
      on success → delete file
      on error → release lock, log, continue
  if queue empty for 5s → exit
  touch ~/.unbrowse/queue/.heartbeat
```

### Opportunistic sweep on startup

Every `unbrowse <verb>` CLI invocation, before doing its work:

```
if exists ~/.unbrowse/queue/*.json AND heartbeat stale (>10s):
  spawn detached __drain-queue
  (don't wait)
```

Pattern is `git gc --auto`. Cheap statvfs check, no perf cost when queue is empty.

### drainPendingIndexJobs (tests + shutdown)

- **Inline mode (tests):** unchanged — wait on in-process promises.
- **Disk mode:** poll queue dir until empty + no lock files held, with timeout. Tests should run in inline mode by default.

### isIndexingInFlight

- **Inline mode:** unchanged.
- **Disk mode:** `exists ~/.unbrowse/queue/<domain>.*.json` OR `flock` held.

---

## Files to touch

| File | Change |
|------|--------|
| `src/indexer/queue-store.ts` | **NEW** — read/write/lock/list job files; atomic writes; flock per domain |
| `src/indexer/worker.ts` | **NEW** — drain loop; calls existing `backgroundIndexProcessor` |
| `src/indexer/index.ts` | Rewrite `queueBackgroundIndex` / `drainPendingIndexJobs` / `isIndexingInFlight` to dispatch inline vs disk |
| `src/cli.ts` | Wire `__drain-queue` verb + startup `sweepStaleJobs()` call |
| `tests/...` | Ensure `UNBROWSE_INLINE_INDEX=1` is set in test setup; new tests for queue-store atomicity, lock semantics, crash-resume, dead-letter |
| `CHANGELOG.md` | Entry under unreleased |

Inline mode (`UNBROWSE_INLINE_INDEX=1`) is the default for `bun test` so the existing test suite is unaffected.

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Worker spawn cost on every close | 2s coalesce window + heartbeat check; only one worker per machine |
| Crash mid-job → orphaned lock | `flock` releases on process death; stale lock cleanup if PID dead |
| Job file partial write | Write `.tmp` then rename; on read, ignore `.tmp` files |
| Dead-letter blow-up | `MAX_ATTEMPTS=3` then move to `dead/`; surface via `unbrowse doctor` |
| Tests depending on `isIndexingInFlight` ordering | Inline mode is default for tests; explicit disk-mode tests gated |
| Two CLI processes spawn workers simultaneously | Worker startup takes a global `~/.unbrowse/queue/worker.lock`; second exits cleanly |

---

## Test plan

1. **Unit — queue-store:** atomic write + rename, list sort order, flock acquire/release, stale-PID cleanup.
2. **Unit — coalesce:** two `queueBackgroundIndex` calls for same domain within 2s → one job file with merged payload.
3. **Integration — crash resume:** kill worker mid-job, restart → job file still present, attempts incremented, eventually succeeds.
4. **Integration — dead-letter:** processor throws 4 times → file in `~/.unbrowse/queue/dead/`.
5. **Integration — inline parity:** with `UNBROWSE_INLINE_INDEX=1`, behaviour is identical to today (existing test suite passes unchanged).
6. **Bench:** `bench-local` runs unchanged; check no regression in capture→publish latency in inline mode.
7. **Agent-XP harness:** run after Phase 1 to confirm no regression in shortlist quality.

---

## Phase 2 (out of scope, follow-up)

Once Phase 1 is stable for a week:

- MCP server exits after each request (or after short idle).
- HTTP `serve` mode becomes optional for users who want it for latency; the default `unbrowse <verb>` shells out to short-lived processes.
- Delete the "always kill stale unbrowse server" footgun note from `CLAUDE.md`.

---

## Open questions

1. Should the worker process be `bun src/cli.ts __drain-queue` from source, or always the global binary? (Probably global, to match the deployed binary path.)
2. Heartbeat file vs PID file — does Lewis prefer one over the other for ops visibility?
3. Do we want `unbrowse doctor` to surface queue depth + dead-letter count now, or in Phase 2?
