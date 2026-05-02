# EmergentDB graph credits exhausted — backend marketplace search returns 0

**Status:** OPEN. Confirmed 2026-05-02.
**Severity:** P0 — every cross-agent marketplace lookup fails silently.
**Owner needed:** billing top-up + reindex (see Recovery).

## Symptom

`POST /v1/intent/resolve` and `POST /v1/search/*` return empty results for
every domain, including domains that have indexed skills in the marketplace
(`/v1/skills` lists them just fine).

```bash
ADMIN=$(grep UNBROWSE_ADMIN_KEY .env | cut -d= -f2)

# 20 skills, 171 endpoints exist in marketplace
$ curl -s https://beta-api.unbrowse.ai/v1/stats/summary
{"skills":20,"endpoints":171,"domains":20,"executions":2638,...}

# But search of any kind returns nothing
$ curl -s -X POST https://beta-api.unbrowse.ai/v1/search/resolve \
    -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
    -d '{"intent":"top stories","domain":"news.ycombinator.com"}'
{"domain_results":[],"global_results":[],"skipped_global":false}
```

The 16 ycombinator skills — and every other indexed domain — are invisible
to search. Until the client-side skill caches were removed in commit
`f6016ce5`, this was masked by stale local route-cache hits; resolve looked
fast and "worked" because it never actually queried the backend index.

## Root cause

EmergentDB graph billing balance is **\$0.000000**. Every `/graph/search`
and `/graph/batch_insert` call gets:

```json
{
  "error": "Insufficient graph credits",
  "balance_micro": 0,
  "balance_usd": "$0.000000",
  "cost_micro": 180,
  "cost_usd": "$0.000180",
  "topup_url": "/dashboard/billing?product=graph"
}
```

Confirmed by direct probe with the EmergentDB API key
`emdb__T_XgwE_Gp1C5Ra5w0Q6Bd1CQ5YFrRW7` (project key, ~/.env-stored;
do NOT paste full key in PRs). Same error returned by the in-prod admin
reindex endpoint:

```bash
$ curl -s -X POST https://beta-api.unbrowse.ai/v1/ops/reindex \
    -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
    -d '{"limit":3,"offset":0}'
{
  "total_active": 20,
  "succeeded": 0,
  "failed": 3,
  "results": [
    {"skill_id":"-PBMHb0nAvFdpiNlX1uJf","ok":false,"error":"Insufficient graph credits"},
    {"skill_id":"0asnVfqrmkWs1UsZhKv7O","ok":false,"error":"Insufficient graph credits"},
    {"skill_id":"1_H-mpH5fCDTQSohRcpjL","ok":false,"error":"Insufficient graph credits"}
  ]
}
```

Two compounding causes:

1. **Credits ran out at some point** — every publish since then failed to
   index, so the embedding namespace is missing those skills entirely.
2. **A `v2-` namespace migration was started in commit `17d67c0b` (Apr 10
   2026) but never completed** — `backend/src/services/discovery.ts:9-13`
   prepends `v2-` (or `stg2-`) to every domain. Skills indexed before that
   commit live in the old unprefixed namespace; the v2 namespace is empty.
   A reindex would migrate them, but reindex needs credits.

## Why the failure is silent

`backend/src/services/discovery.ts:325-348` calls
`Promise.allSettled([graphSearch, bm25Search])` and on rejection only
warns to console:

```ts
if (graphSettled.status === "rejected")
  console.warn(`[search] graph search failed: ${graphSettled.reason}`);
```

The catch block returns `[]` to the caller. The handler in
`backend/src/routes/search.ts:178-181` further swallows any thrown error
into `{ domain_results: [], global_results: [], skipped_global: false }`.
There is no health surface, no metric, no alert. Search has been broken
in this exact way for ~indeterminate time and the product looked healthy
because the client-side caches kept serving stale-but-callable routes.

The BM25 KV fallback also produces zero results because BM25 docs are
written *inside* `indexEndpoints` (same call path that does the EmergentDB
batch_insert). When credits ran out, both indexing paths went silent.

## Recovery (cannot be done by the agent)

1. **Top up EmergentDB graph credits** at the URL EmergentDB returns:
   `https://api.emergentdb.com/dashboard/billing?product=graph`
   (the `EMERGENTDB_API_KEY` wrangler secret on `unbrowse-backend`).
   Realistically need >> $0.01 for 171 endpoints × backfill + headroom.
2. **Reindex everything into the v2 namespace** once balance > 0:
   ```bash
   ADMIN=$(grep UNBROWSE_ADMIN_KEY .env | cut -d= -f2)
   for off in 0 3 6 9 12 15 18; do
     curl -s -X POST https://beta-api.unbrowse.ai/v1/ops/reindex \
       -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
       -d "{\"limit\":3,\"offset\":$off}"
     sleep 2
   done
   ```
3. **Verify** with a known-indexed domain:
   ```bash
   curl -s -X POST https://beta-api.unbrowse.ai/v1/search/resolve \
     -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
     -d '{"intent":"top stories","domain":"news.ycombinator.com"}'
   # expect non-empty domain_results
   ```

## Code-level fixes worth shipping after recovery

These prevent the same outage class from going silent again:

- **Surface the failure**: in `backend/src/services/discovery.ts` change the
  search/index error handlers to mark and re-throw `Insufficient graph
  credits` as a typed error; expose at `/v1/health` (or a new
  `/v1/ops/health`) so monitoring can alert.
- **Auto-deprecate empty-namespace domains** instead of returning empty
  results — give the client an actionable signal (`source:
  "search_index_unavailable"`) so it can fall back to direct capture rather
  than failing to find a known skill.
- **Re-test publish path**: the `marketplace.ts` flow logs index failures
  via `console.error("[indexEndpoints] failed for ${skill.skill_id}: ...")`
  but still marks the skill as published. Either gate publish on successful
  index or persist `needs_reindex: true` so a background sweep can repair.

## Related

- Files touched in this investigation:
  `backend/src/services/discovery.ts`,
  `backend/src/routes/search.ts`,
  `backend/src/routes/ops.ts`,
  `backend/src/middleware/auth.ts`.
- Client-side cache removal that exposed the bug: `f6016ce5`.
- Recent fixes shipped while diagnosing: `cb3df824` (Fastly detector),
  `b6663acf` (aggregator card link picker),
  `4451a4ce` (anti-bot visible-browser auto-fallback).
