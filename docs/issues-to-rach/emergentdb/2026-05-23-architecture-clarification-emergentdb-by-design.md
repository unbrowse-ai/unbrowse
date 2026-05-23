# Architecture clarification: EmergentDB qdkv is NOT a general KV (by-design)

**Severity:** N/A (clarification, not a bug)
**Source:** unbrowse OSS-source audit 2026-05-23 — `oss/emergentDB/crates/api-server/src/handlers.rs` + `oss/emergent-sdk/typescript/src/index.ts`
**Source contract:** unbrowse `37b21004` (lean architecture)
**Reporter:** Lewis via /contract

## What we got wrong (unbrowse side)

We had been treating EmergentDB's `/qdkv/set` as a general-purpose KV — pushing 615 skill manifests (some >10 KB) into it as a backup-store for Cloudflare KV. That collides with three EmergentDB realities we discovered by reading the OSS source:

| Surface | Actual contract |
|---|---|
| `vector_search` (`handlers.rs:169`) | Returns `{id, score}` only. Metadata is **never persisted on the vector path** (`vector_insert` accepts a `metadata` arg but the handler does not pass it to storage). |
| `vector_batch_insert` (`handlers.rs:240`) | Accepts 1000 vectors per HTTP call. The SDK enforces this cap; OSS handler iterates in-memory. |
| `qdkv/*` | Hosted-only thin companion KV (not in OSS). Has a ~10 KB cap (silent drop above) and harsh per-tenant rate limit (~36/min). |

## What EmergentDB IS designed for

1. **Fast vector search** on integer-keyed embeddings. That's the core value (51-82× faster than ChromaDB / LanceDB per `BENCHMARKS.md`).
2. **Small companion KV** for application metadata, keyed by the same integer id. Look up metadata AFTER search; do not expect it inline in `/vectors/search` results.
3. **Bulk insertion** at 1000/call via `/vectors/batch_insert`.

## Lean architecture for unbrowse (shipping)

```
EmergentDB     :  vectors only       (id: int, vector: float[1536])
                  via /vectors/batch_insert  (1000/call)
                  via /vectors/search

Cloudflare KV  :  metadata by id     (env.STATS_KV)
                  bm25-idx:<domain>  — BM25 docs with our metadata at index time
                  per-id metadata   — for post-search join

Postgres (Neon):  skill manifests    (canonical, no size cap)
                  USE_PGKV=1 stays on
                  this is where full skill JSON lives
```

Search flow (already shipped — commit `eeffa787`):
1. `/vectors/search` → `[{id, score}]`
2. BM25 fallback over `bm25-idx:<domain>` provides identifying metadata
3. RRF-fuse; rescore via composite formula; filter suppressed domains; return

Insert flow (target — to be wired in a follow-up commit):
1. Hash `skill_id:endpoint_id` → positive int (collision-handled via SHA-256 → u64)
2. `/vectors/batch_insert` with up to 1000 endpoints per call
3. Mirror metadata into `bm25-idx:<domain>` in Cloudflare KV (already done by `indexEndpoints`)

## What this retires

Three contracts from earlier this turn, superseded by `37b21004`:

- `e657a740` "unbrowse is fully on EmergentDB" — wrong framing
- `e65c7118` "execute the migration to qdkv" — wrong target
- `f2f7aeb1` "flip USE_PGKV off on prod" — premature; PgKV stays primary

The migration route (`POST /v1/ops/migrate-pgkv-to-edb`) stays in the codebase for posterity — it's a useful primitive if a future need for qdkv migration arises — but it's no longer load-bearing for the architecture.

## What stays as real EmergentDB bugs

Even with the architecture clarification, two issues remain on `justrach/emergentDB`:

- **#4 (P1)** — `qdkv/set` silently drops values >10 KB. Now lower priority for us (we don't push large values to qdkv), but still a real wart for any tenant who reaches for qdkv as a KV.
- **#7 (closed)** — qdkv rate limit. Mitigated by `/vectors/batch_insert` for our use; left as a docs/SDK ask if `qdkv/mset` would benefit other tenants.

And one closed-as-by-design:

- **#5 (closed)** — `/graph/search` metadata-less. Reclassified as a docs/SDK cleanup (the `includeMetadata: true` flag is a no-op against the OSS handler).

## References

- unbrowse contract `37b21004` (this architecture)
- unbrowse contracts retired this wave: `e657a740` `e65c7118` `f2f7aeb1` (visible via `contract list --show-merged`)
- OSS source: `/Users/lekt9/Projects/oss/emergentDB/crates/api-server/src/handlers.rs`
- TS SDK: `/Users/lekt9/Projects/oss/emergent-sdk/typescript/src/index.ts`
- unbrowse `backend/src/services/discovery.ts:indexEndpoints` — the index path that will move to `/vectors/batch_insert`
- unbrowse `backend/src/services/kv.ts:EdbKV` — keeps the BUG-011 client-side guard regardless
