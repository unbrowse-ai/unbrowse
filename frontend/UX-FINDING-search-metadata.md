# UX finding — the front-door search returns unidentifiable results (story S1 blocker)

**Severity: high.** This is the first thing a new visitor does (homepage registry +
`/search`), and it currently renders garbage. Dogfound 2026-06-04 by hitting the live API.

## Symptom (run it)

The live global search returns ranked results whose `metadata` is **empty**, so the
renderer (`frontend/src/components/search-results.tsx`) falls back to
**"Untitled" / "No intent signature provided"** rows — opaque, unclickable-looking
results on the literal front door.

```bash
for q in "top stories hacker news" "weather forecast" "github repos"; do
  curl -s -X POST https://beta-api.unbrowse.ai/v1/search \
    -H 'content-type: application/json' -d "{\"intent\":\"$q\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d["results"];print(len(r),"results,",sum(1 for x in r if not x["metadata"]),"empty-metadata")'
done
# → 5 results, 5 empty-metadata   (every query, systemic)
```

Result shape returned: `{ id: 10310, score: 0.61, metadata: {} }` — an opaque graph
node id and a score, nothing to render.

## Root cause (exact)

`backend/src/services/discovery.ts` → `searchIntent()` (lines ~485–507). Global search
RRF-fuses two sources:
- **`graphSearch`** (EmergentDB `/graph/search`) returns **metadata-less `{id, score}`**
  by design — the comment at discovery.ts:486 says so explicitly.
- **`bm25Search`** (docs in `STATS_KV` `bm25-idx:<domain>`) carries the metadata
  (skill_id, domain, intent, title) written at index time.

The fusion only yields identifiable results **when bm25 returns rows**
(`if (bm25Results.length > 0) results = rrfFuse(...) else results = graphResults`).
The live response being 100% empty metadata means **the global BM25 index
(`bm25-idx:global` in STATS_KV) is empty/unpopulated**, so `searchIntent` falls back to
the metadata-less graph path for every query.

## Fix options (backend — not cleanly frontend-fixable)

1. **Populate / rebuild the global BM25 metadata index** so `bm25Search(env, "global", …)`
   returns rows carrying skill_id/domain/title. This is the real fix; it restores
   identifiable front-door results. (Needs a backend deploy + index job.)
2. **Server-side enrich** the metadata-less graph results before returning: map each
   graph node `id` → its skill metadata from the registry store, and attach
   `{skill_id, domain, intent, title}`. Removes the dependency on BM25 being warm.
3. **Frontend stop-gap (weak):** drop results with empty metadata so the page shows an
   honest "No results" instead of "Untitled" rows. Rejected for now — with the index
   empty it makes the front door look empty, which is worse than mislabelled rows.

## Verification (after fix)

The same curl loop must show `empty-metadata = 0`, and each result's metadata must
carry a `skill_id` (or `domain`/`intent`) that `search-results.tsx` can render and link.

## Status

`[diagnosed]` — root-caused and reproducible against the live API. `[blocked]` on a
backend index/deploy; not shippable from the frontend alone. This is the #1 first-
impression blocker for story S1 (the front door must *show* it works, not render
"Untitled").
