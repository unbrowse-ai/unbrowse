# Unbrowse Search Bugs

Investigated 2026-02-23.

---

## Architecture Context

A skill touches **5 stores** when published:

| Store | Key/Namespace | Purpose | Written by | Read by |
|-------|--------------|---------|------------|---------|
| KV `skill:{id}` | `skills` namespace | Full manifest | `publishSkill()` | `getSkill()`, `listSkills()`, `GET /v1/skills` |
| KV `intent-idx:{domain}:{hash}` | `skills` namespace | Dedup guard | `publishSkill()` | `findExistingByIntent()` (publish-time only) |
| Vector `unbrowse--global` | EmergentDB vectors | Global semantic search | `indexSkill()` (fire-and-forget) | `POST /v1/search` |
| Vector `unbrowse--{domain}` | EmergentDB vectors | Domain-scoped search | `indexSkill()` (fire-and-forget) | `POST /v1/search/domain` |
| KV `search-cache` | `search-cache` namespace | 5-min result cache | After vector search | Before vector search |

The `intent-idx` keys are **only** used for dedup during publish — they are **never** used for search. All search goes through the vector index.

There is **no reindex endpoint**. The only reindex tool is the standalone `migrate-kv.mjs` script.

---

## BUG-003: Global vector index out of sync with KV — migration script used wrong namespace

**Severity**: Critical — global search is fundamentally broken

**Root cause**: `backend/migrate-kv.mjs:182` writes vectors to `"unbrowse-skill"` but the search code reads from `"unbrowse--global"` (`discovery.ts:11`). The migration script populated the wrong namespace. The live `indexSkill()` function was also temporarily pointed at the wrong namespace before commit `07e38a9` fixed it.

**Evidence**:

```
# migrate-kv.mjs line 182:
vectorInsert("unbrowse-skill", numericId, vector, meta)   // WRONG

# discovery.ts line 11:
const GLOBAL_NS = "unbrowse--global";                      // CORRECT (after fix)
```

**Impact**: Only 4 of 6+ skills appear in global search. Skills published during the wrong-namespace period are indexed in `unbrowse-skill` (dead namespace). Skills published after the fix go to `unbrowse--global` correctly, but older skills are permanently invisible to global search.

Domain-scoped search (`POST /v1/search/domain`) is unaffected because `domainNamespace()` was always correct.

**Data snapshot**:

| Skill ID | Domain | In KV | In `unbrowse--global` | In domain NS |
|----------|--------|-------|-----------------------|-------------|
| `nzEhHWKnhPYkpx4_bw_bt` | believescreener.com | YES | NO | ? |
| `zciYL_L8lpUWVz2v51lgf` | www.believescreener.com | YES | NO | ? |
| `3aKQL0MPkbXlByIy53gUF` | enviro.epa.gov | YES | NO | ? |
| `aMP3Poi1CDIwilumQ7tBV` | openrouter.ai | YES | NO | YES |
| `FzQleAbL-nt5iQYWP4-Br` | enviro.epa.gov | YES | YES | YES |
| `UAnkj97bkOCSp4K2BYKGB` | enviro.epa.gov | YES | YES (no metadata) | ? |
| `HLHFLF2qQo_JHBelPGZOD` | cumulis.epa.gov | YES* | YES | ? |
| `O_LbgkTvD799LaDO0RKjf` | www.tradingview.com | NO | YES (ghost) | ? |

**Fix**:
1. Fix `migrate-kv.mjs:182` to use `"unbrowse--global"` instead of `"unbrowse-skill"`
2. Build a `POST /v1/ops/reindex` endpoint that iterates all KV skills and re-indexes into both vector namespaces
3. Run it once to repair the index

---

## BUG-004: Ghost vectors — stale entries for deleted skills

**Severity**: Medium — search returns 404 skills

**Symptom**: Skill `O_LbgkTvD799LaDO0RKjf` (TradingView) appears in search results but `GET /v1/skills/O_LbgkTvD799LaDO0RKjf` returns 404.

**Root cause**: When a skill is overwritten via `publishSkill()` (same intent+domain → version bump), the old skill gets a new `skill_id`. The old vector entry is never cleaned up because `publishSkill()` doesn't call `removeSkillFromIndex()` for the old entry — it only calls `indexSkill()` for the new one.

`deprecateSkill()` does call `removeSkillFromIndex()`, but direct overwrites during re-publish don't.

**Fix**: In `publishSkill()`, when `findExistingByIntent()` returns an existing skill and we're updating it, we should use the same `skill_id` (which it already does via `skill_id: existing.skill_id`). So this ghost was likely created when the dedup mechanism failed (e.g., intent hash collision, or the skill was deleted from KV but not from the vector index during the namespace migration).

The reindex operation from BUG-003 will fix this — it should also purge vectors whose `skill_id` no longer exists in KV.

---

## BUG-005: Vector entry has no metadata

**Severity**: Medium — search returns unusable result

**Symptom**: Skill `UAnkj97bkOCSp4K2BYKGB` (vector ID `127205107`) returns `{"id": 127205107, "score": 0.608913}` with no `metadata` object.

**Root cause**: Likely a partial write during indexing — the vector was inserted but metadata was lost. Could be an EmergentDB issue or a race during the migration.

**Fix**: Reindex will fix. Also, `searchIntent()` and `searchIntentInDomain()` should filter out results with missing metadata before returning to clients.

---

## BUG-006: Three vectors always return identical similarity scores

**Severity**: Low — ranking anomaly

**Symptom**: Vector IDs `1988318765`, `2334842`, `127205107` always score identically regardless of query (e.g., all three return `0.60701364` for "search products", `0.51446867` for "get weather forecast").

**Root cause**: These three vectors have identical or near-identical embedding data stored in EmergentDB. Cosine similarity with any query vector produces the same score when target vectors are identical. This could have happened if `indexSkill()` was called with the same `intentSignature` text for all three (a bug in the batch indexing), or if the embeddings were duplicated during migration.

**Fix**: Reindex with correct per-skill intent signatures.

---

## BUG-007: `indexSkill()` silently swallows failures

**Severity**: Medium — indexing failures are invisible

**Location**: `backend/src/services/marketplace.ts:90-98`

```typescript
// Fire-and-forget — don't block the response on Gemini embed + vector insert
indexSkill(env, skill.skill_id, skill.intent_signature, { ... }).catch(() => {});
```

**Impact**: When vector indexing fails (Gemini API error, EmergentDB down, etc.), the skill is saved to KV and the API returns success, but the skill is invisible to search. There's no retry, no logging, no way to know it happened.

**Fix**: At minimum, replace `.catch(() => {})` with `.catch(err => console.error("[indexSkill] failed:", skill.skill_id, err.message))` so failures appear in Worker logs. Consider adding a `needs_reindex` flag on the skill manifest.

---

## BUG-008: `/v1/ops` dashboard is unauthenticated

**Severity**: Low — exposes operational data publicly

**Location**: `backend/src/routes/ops.ts` — mounted as public route in `index.ts:31`

**Impact**: `GET /v1/ops` returns full skill listings, agent profiles, and aggregate stats with no auth. Anyone can access it.

**Fix**: Add `bearerAuth` middleware or at least require the admin API key.

---

## BUG-009: `migrate-kv.mjs` has hardcoded API keys

**Severity**: High (security) — credentials in source

**Location**: `backend/migrate-kv.mjs:9-10`

```javascript
const EMERGENTDB_API_KEY = "emdb_HgUO931Kj9BZQHppxTBB3VsoSibXozcS";
const GEMINI_API_KEY = "REMOVED_GOOGLE_API_KEY";
```

**Fix**: Move to env vars. The file is untracked (in .gitignore) but should still not contain raw secrets.

---

## BUG-010: `_idx` written with old string[] format by migrate-kv.mjs

**Severity**: Low — one-time conversion handled by kv.ts

**Location**: `backend/migrate-kv.mjs:198` writes `_idx` as `string[]` (array of key names), but `kv.ts:133-138` expects `{k, v}[]` entries.

**Impact**: On first load after migration, `_idxLoad()` detects the old format and converts in-place. This works, but means values aren't cached in the index — each `get()` requires a separate HTTP fetch until the index is re-saved with values. This was already handled by the kv.ts migration logic, but the migrate script should be updated to write the new format.

---

## BUG-011: KV `_idx` silently exceeds EmergentDB value size limit

**Severity**: Critical — the root cause of publish→search breakage

**Root cause**: `kv.ts` stored the full JSON manifest value in the `_idx` entry's `v` field (e.g. `{k:"skill:abc", v:"<2KB manifest JSON>"}`). As skills accumulated, the `_idx` value grew past ~10KB. EmergentDB's `qdkv/set` returns `{ok: true}` even when the value exceeds its storage limit, but the data is silently lost. This means:
- `_idxSave()` silently fails when the idx is too large
- New skills published after the limit are never added to the idx
- `listSkills()` (which reads from idx) stops returning new skills
- Reindex doesn't see the new skills → they're never vector-indexed → search can't find them

**Evidence**:
- Direct `qdkv/get` for individual skill keys works fine
- `qdkv/set` with 11KB value returns `{ok: true}` but the value reads back as empty
- `qdkv/set` with <1KB value works correctly

**Fix applied**: Changed `kv.ts` to store only empty `v` strings in the `_idx` (keys-only index). `listWithValues()` now fetches actual values via direct `qdkv/get` calls for entries with empty `v`. This keeps the idx small regardless of how many skills exist.

**Files changed**: `backend/src/services/kv.ts` — `putBatch()`, `_idxUpsert()`, `listWithValues()`

---

## BUG-012: Search returns only 2 results; domain search returns 500

**Severity**: Critical — search is nearly useless

**Date**: 2026-02-23

**Symptom**: Global vector namespace (`unbrowse--global`) only contained 2 vectors (opensea.io and dotaprotracker) out of 10+ active skills. Every search query returned the same 2 results regardless of intent. Domain-scoped search (`POST /v1/search/domain`) returned 500 Internal Server Error for all domains.

**Root cause (multi-part)**:
1. `indexSkill()` was fire-and-forget in `publishSkill()` — failures swallowed by `.catch()`, so most vectors were never written
2. Search routes had no error handling — EmergentDB errors on empty/non-existent namespaces propagated as 500s
3. Reindex endpoint processed all skills in one invocation, hitting CF Workers subrequest limits (~50 on free plan), so reindex attempts also silently failed partway through

**Fix applied**:
1. `backend/src/routes/search.ts` — Added try/catch on both handlers; returns `{ results: [] }` on error instead of 500
2. `backend/src/routes/ops.ts` — Added `limit`/`offset` batching to `POST /v1/ops/reindex` (default: 3 skills per call) to stay within CF subrequest budgets
3. `backend/src/services/marketplace.ts` — Changed `indexSkill()` from fire-and-forget to `await`; returns `index_status` field in publish response (`"ok"` or error message)
4. `backend/src/services/discovery.ts` — Wrapped `edbRequest` calls in `searchIntent`/`searchIntentInDomain` with try/catch; EmergentDB errors return `[]` instead of throwing

**Verification**: Deploy, then reindex in batches:
```
POST /v1/ops/reindex {"limit": 3, "offset": 0}
POST /v1/ops/reindex {"limit": 3, "offset": 3}
POST /v1/ops/reindex {"limit": 3, "offset": 6}
...
```
Then confirm `POST /v1/search {"intent": "get stock data", "k": 10}` returns stocktwits/optionslam skills, and `POST /v1/search/domain {"intent": "get options data", "domain": "optionslam.com"}` returns results instead of 500.

---

## Summary: Fixes Applied

| Fix | Status | File |
|-----|--------|------|
| `POST /v1/ops/reindex` endpoint | Done | `backend/src/routes/ops.ts` |
| Filter null-metadata search results | Done | `backend/src/services/discovery.ts` |
| Log indexing failures | Done | `backend/src/services/marketplace.ts` |
| Fix `migrate-kv.mjs` namespace | Done | `backend/migrate-kv.mjs` |
| KV idx stores keys-only (no full values) | Done | `backend/src/services/kv.ts` |
| Search route error handling (try/catch) | Done | `backend/src/routes/search.ts` |
| Batched reindex with limit/offset | Done | `backend/src/routes/ops.ts` |
| Await indexSkill + return index_status | Done | `backend/src/services/marketplace.ts` |
| Harden search functions (try/catch in discovery) | Done | `backend/src/services/discovery.ts` |

## Remaining (not fixed yet)

- **Auth-gate `/v1/ops`** — currently public, should require admin key
- **Ghost vectors in EmergentDB** — old stale vectors from migration still exist in `unbrowse--global`. They'll be pushed down in results by real skills and will eventually be irrelevant. A full purge would require listing all vector IDs in EmergentDB (no API for this exists).
- **`migrate-kv.mjs` hardcoded API keys** — file is untracked but should use env vars
