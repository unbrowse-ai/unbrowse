# EmergentDB issue: `/graph/search` returns metadata-less results even with `include_metadata: true`

**Severity:** P1 (forces client-side workaround; broke unbrowse `/v1/search` until we shipped a fix)
**Surface:** `POST https://api.emergentdb.com/graph/search`
**Source contract:** unbrowse `8b2f65ea` (empty-search-after-reindex root-cause)
**Reporter:** Lewis via /contract (unbrowse `04e535fe`)

## Symptom

`/graph/search` returns only `{id, score}` per result — the `metadata` field is missing — regardless of whether `include_metadata: true` is passed. Metadata IS being stored on insert (via `/graph/batch_insert` with `items: [{id, text, metadata: {...}}]`); it just never comes back on search.

## Reproduction

```bash
EDB="<EMERGENTDB_API_KEY>"

# Try every plausible flag for metadata return
for FLAG in '"include_metadata":true' '"with_metadata":true' \
            '"include_metadata":1'    '"return_metadata":true'; do
  curl -sS -X POST 'https://api.emergentdb.com/graph/search' \
    -H "Authorization: Bearer $EDB" -H 'content-type: application/json' \
    -d "{\"domain\":\"v2-global\",\"query\":\"linkedin\",\"k\":1,$FLAG}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('results', [{}])[0]
print(f'flag=$FLAG  keys={sorted(r.keys())}  has_metadata={bool(r.get(\"metadata\"))}')
"
done
```

Observed:

```
flag="include_metadata":true   keys=['id','score']  has_metadata=False
flag="with_metadata":true      keys=['id','score']  has_metadata=False
flag="include_metadata":1      keys=['id','score']  has_metadata=False
flag="return_metadata":true    keys=['id','score']  has_metadata=False
```

Default (no flag) returns the same `{"id","score"}` shape, confirmed by:

```bash
curl -sS -X POST 'https://api.emergentdb.com/graph/search' \
  -H "Authorization: Bearer $EDB" -H 'content-type: application/json' \
  -d '{"domain":"v2-global","query":"linkedin","k":1}'
# → {"results":[{"id":"2416","score":0.60328812}],"count":1,"dimensions":1536}
```

`/graph/get?domain=...&id=...` also returns `{"error":"Not found"}` for IDs returned by search, so there's no companion read-by-id path to recover metadata either.

## Why this matters (unbrowse side)

Our backend uses the returned metadata to (a) drive `composite_score` (reliability, freshness, verified-ratio fields are JSON-encoded in `metadata.content`), (b) apply marketplace domain suppression (`metadata.source_url`), and (c) tell the client which `skill_id` the vector belongs to (`metadata.content.skill_id`). With metadata missing, our rescore step deref'd `r.metadata.source_url` on undefined, threw TypeError, and the route's try/catch zeroed every search response.

That's what `/v1/search` looked like for ~2 weeks: `{"results":[]}` for every query. Diagnosed only after probing EmergentDB directly and seeing the bare `{id, score}` shape.

We shipped a defensive workaround (commit `eeffa787` in `unbrowse-ai/unbrowse-dev`):

1. Normalize missing/null metadata to `{}` before any field access.
2. Parallel BM25 fallback (we keep a separate `bm25-idx:<domain>` in Cloudflare KV from index time, with the metadata we wrote ourselves) and RRF-fuse with graph results.

The BM25 fallback covers identity, but it shouldn't be necessary if `/graph/search` honored the metadata flag.

## Expected

When `include_metadata: true` is set, every `results[i]` includes the `metadata` object that was provided at `/graph/batch_insert` time, byte-for-byte.

## Open question

Was the metadata persisted at all? If `/graph/batch_insert` is silently dropping it, that's also a write-side fix candidate. We can't tell from outside because there's no `/graph/get` for id → record.

## References

- unbrowse `backend/src/services/discovery.ts:graphSearch` — sends `include_metadata: true`
- unbrowse `backend/src/services/discovery.ts:indexEndpoints` — writes metadata at insert
- unbrowse `backend/tests/search-metadata-less-graceful.test.ts` — the defensive regression test we now ship
