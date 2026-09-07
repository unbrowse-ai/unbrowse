# src/lib/indexer-core — Design Notes

## What lives here

Queue-backed local graph indexer (`index.ts` → `queue-store.ts` + `worker.ts` + `durable-index-jobs.ts`). `queueBackgroundIndex` creates a `BackgroundIndexJob{skill,domain,intent,cacheKey}` with durable envelope; `worker.drainOnce` locks per-domain, heartbeats, then `indexSkillLocally` + optional `publishIndexedSkill`.

## Invariants

- Index never blocks foreground: caller does `queueBackgroundIndex` and returns; `deferCapturePipeline` swallows errors. `pendingBackgroundIndexCompletions` / `acknowledgeBackgroundIndexCompletion` track flight.
- Dead-letter after `maxAttempts` → `queue/dead/`; rejected JSON → `queue/quarantine/<reason>/`. Stale `.tmp` swept via `sweepStaleTmp`.
- Domain merge via `findAndMergeDomainSnapshot` + `sameRouteScope` (host-scoped, `www.`-sibling aware) — `mergeEndpoints` accumulates `api.example.com` into `example.com` intentionally.
- Publication inside indexer is still permit-gated — legacy side-path without lifecycle proof stays fail-closed at transport (`publishSkill` boundary strips `operation_graph[].page_metadata.localStorage`).
