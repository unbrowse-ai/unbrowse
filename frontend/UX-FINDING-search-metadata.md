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

## Deepened root cause (confirmed against code + tests)

- The metadata-less path is **graceful by design** — contract 8b2f65ea
  (`backend/tests/search-metadata-less-graceful.test.ts`) made `rescoreWithComposite`
  attach an empty `{}` instead of crashing. So empty metadata is *expected* when BM25
  is cold; it is not a crash, it is an unidentifiable-but-non-fatal result.
- EmergentDB `/graph/search` returns **id-only** even with `include_metadata: true`
  (stated at discovery.ts:486), so there is **no server-side enrichment path from the
  graph `id`** — the numeric node id has no skill mapping. The *only* metadata source
  is the BM25 index.
- Therefore the fix is necessarily **"make `bm25-idx:global` non-empty in the store the
  read path queries."** The index IS written on every skill index
  (discovery.ts:185/191, `STATS_KV.put('bm25-idx:'+domain)`), so its emptiness on prod
  points to a **data/migration issue** — note `backend/migrate-cf-kv-to-neon.mjs`: a
  KV→Neon migration likely left `bm25-idx:global` stranded, or the read path
  (`STATS_KV.get`) no longer points at where the data now lives.

## Concrete next action (needs prod/deploy access — not solo-shippable)
1. Check whether `STATS_KV` `bm25-idx:global` exists in prod and is non-empty; if the
   KV→Neon migration moved it, repoint the read at the new store or backfill the key.
2. Re-run the verification curl loop; require `empty-metadata = 0`.
3. (Optional, gated by a backend test) add `searchIntent` resilience: if a query yields
   only metadata-less results, trigger a background reindex of `global` so the BM25
   index self-heals rather than staying cold.

## Status

`[diagnosed]` — root-caused to the empty global BM25 index, confirmed against the
code + the 8b2f65ea test; reproducible against the live API. `[blocked]` on backend
data/deploy access (no code-level enrichment exists, by EmergentDB's id-only design).
The #1 first-impression blocker for story S1 — a preview is not worth sending while the
front door renders "Untitled."
