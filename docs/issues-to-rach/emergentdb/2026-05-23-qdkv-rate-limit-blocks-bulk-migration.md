# EmergentDB issue: `qdkv` per-isolate rate limit (~36/min, 60s retry-after) makes bulk migration impractical

**Severity:** P2 (no data loss; throughput ceiling)
**Surface:** `POST https://api.emergentdb.com/qdkv/set` (rate-limit at the API gateway)
**Source contract:** unbrowse `e65c7118` (PgKV → EdbKV migration)
**Reporter:** Lewis via /contract (unbrowse `04e535fe`)

## Symptom

When migrating ~100K rows from Neon Postgres into EmergentDB qdkv from a Cloudflare Worker, sustained throughput caps at **~36 writes/minute per isolate**. 429s carry `retry_after_seconds: 60`. Same code from a local machine (direct, not via the Worker) bursts 30 parallel writes with 0 failures — so the limit is per-source-IP at the EmergentDB API edge, and a CF Worker isolate is the source.

## Observed numbers

- `CHUNK_SIZE=16` (16 concurrent `qdkv/set` per chunk) → ~50% 429s, ~36 successes per pass of 100 rows.
- `CHUNK_SIZE=6` (after we backed off) → near-zero 429s but throughput stays at ~36/min.
- 615-row namespace (`skills-v2`) drains in ~17 min with patient `sleep 65` between calls.
- 97,862-row namespace (`stats`) projects to ~46 hours of sustained Worker calls. Operationally not feasible in a single migration window.

Response header on a 429:

```
HTTP/2 429
{"error":"Rate limit exceeded","retry_after_seconds":60,...}
```

## Why this matters (unbrowse side)

We're trying to flip `USE_PGKV` off on prod so all KV reads go to qdkv (the Apr-21 Neon migration → 2026-05-21 EmergentDB rollback round-trip). Until ALL skills are migrated, the flip would 404 marketplace reads for the un-migrated tail. With the current rate limit, the migration is gated on multi-day background draining.

A bulk `qdkv/mset` or higher per-tenant rate limit would let us finish the cutover in one operator window instead of staging it across days.

## Reproduction

```bash
# From a CF Worker (high 429 rate):
# inside our POST /v1/ops/migrate-pgkv-to-edb route, see backend/src/routes/ops.ts:407
# Result: 36/100 → 429 → retry 60s later

# From local (no rate limit observed at this load):
EDB="<EMERGENTDB_API_KEY>"
for i in $(seq 1 30); do
  curl -sS -o /dev/null -w "%{http_code} " -X POST 'https://api.emergentdb.com/qdkv/set' \
    -H "Authorization: Bearer $EDB" -H 'content-type: application/json' \
    -d "{\"key\":\"test:burst:$i\",\"value\":\"x\"}" &
done
wait
# → 200 200 200 200 200 ... (30/30 all 200, no 429)
```

So the limit is enforced per-source-IP and CF Workers from `cf-placement: local-SIN` hit one shared bucket on the EmergentDB side.

## Asks (any one helps; all three would be ideal)

1. **Bulk write endpoint** — `POST /qdkv/mset` accepting `{items: [{key, value, ttlMs?}]}` so an N-row migration is 1 HTTP call, not N. Our `EdbKV.putBatch` already wants this shape on the client side; we just emulate it with `Promise.all(N × put)`. We probed `set_batch`, `batch`, `put_batch`, `mset` — all `{"error":"Not found"}`.
2. **Per-tenant rate-limit headroom** — flag the unbrowse API key (`emdb__...`) for higher per-second writes during the migration window. Even 5× the current ceiling brings 46h → ~9h, which fits in an overnight drain.
3. **`Retry-After`-aware client guidance** — if the limit is hard for good reasons, surface `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers on EVERY response (right now they're in `access-control-expose-headers` but not always emitted). We'd plumb intelligent backoff if we had real-time signal.

## Why the .md instead of a Slack ping

Per our /contract `2dbdf6d6`: every EmergentDB issue gets reproducible repro + impact + ask in a single .md so it's diff-able, searchable, and won't get lost in chat. Happy to drop these into Telegram/GitHub issues too — let me know your preferred channel.

## References

- unbrowse `backend/src/routes/ops.ts:migrate-pgkv-to-edb` — the migration route that hits this
- unbrowse `backend/src/services/kv.ts:EdbKV.put` — client-side wrapper we'd retire on a bulk endpoint
- unbrowse contract `e65c7118` (this migration)
- DRY_RUN result from prod 2026-05-23: 100,909 rows total across 8 PgKV namespaces (`skills-v2:615, skills:761, stats:97862, staging-stats:1453, staging-skills-v2:12, staging-skills-v3:1, sys:1, telemetry-rate:204`)
