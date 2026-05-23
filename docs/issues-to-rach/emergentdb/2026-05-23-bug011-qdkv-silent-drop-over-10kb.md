# EmergentDB issue: `qdkv/set` silently drops values >10 KB (BUG-011, reproduces 2026-05-23)

**Severity:** P0 (silent data loss)
**Surface:** `POST https://api.emergentdb.com/qdkv/set`
**Source contract:** unbrowse `8b2f65ea` (empty-search investigation), `e65c7118` (PgKV → EdbKV migration)
**Reporter:** Lewis via /contract (unbrowse `04e535fe`)

## Symptom

`qdkv/set` returns `{"ok":true}` for values larger than ~10 KB but a subsequent `qdkv/get` for the same key returns `{"value":null,"found":false}`. The write is acknowledged, the data is gone.

## Reproduction

```bash
EDB="<EMERGENTDB_API_KEY>"
for SIZE in 1000 5000 10000 15000 50000; do
  PAYLOAD=$(python3 -c "print('x' * $SIZE)")
  SET=$(curl -sS -X POST 'https://api.emergentdb.com/qdkv/set' \
    -H "Authorization: Bearer $EDB" -H 'content-type: application/json' \
    -d "{\"key\":\"test:size:$SIZE\",\"value\":\"$PAYLOAD\"}")
  GET=$(curl -sS "https://api.emergentdb.com/qdkv/get/test:size:$SIZE" \
    -H "Authorization: Bearer $EDB" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"found={d.get('found')} len={len(d.get('value','') or '')}\")
")
  echo "size=$SIZE  set=$SET  get=$GET"
done
```

Observed:

```
size=1000   set={"ok":true}  get=found=True  len=1000
size=5000   set={"ok":true}  get=found=True  len=5000
size=10000  set={"ok":true}  get=found=False len=0     ← silent loss starts here
size=15000  set={"ok":true}  get=found=False len=0
size=50000  set={"ok":true}  get=found=False len=0
```

## Expected

Either persist the full value, or reject the write with an explicit error (HTTP 4xx + body like `{"error":"value_too_large","limit_bytes":10240}`). Right now the `200 {"ok":true}` is a false witness — clients have no way to know the data was dropped without an immediate read-after-write check.

## Why this matters (unbrowse side)

We hit this twice in 24 hours:

1. **PgKV → EmergentDB migration**: our migration route (`POST /v1/ops/migrate-pgkv-to-edb`) was reporting `written=N` based on the `200 {"ok":true}` response, but every skill manifest >10 KB never landed. The migration looked successful; the data was empty. Diagnosed only by direct `qdkv/get` round-trip on a "successfully migrated" key.
2. **Indexing path** (already a contract on our side, `311771e1`): we ship a client-side `EdbKV.put` pre-write size gate (`backend/src/services/kv.ts:assertWithinSizeLimit`, default 10 KB) so writes fail LOUDLY at the caller. Without that gate every oversize publish was a no-op.

Every client touching qdkv has to re-implement this size gate. Fixing it at the API would let `EdbKV.put`'s defensive code go away.

## Suggested fix (any one)

- Return `413 Payload Too Large` (or `400 value_too_large`) with the actual byte limit in the body.
- Or: persist the full value (raise the limit), since the on-the-wire JSON already accepted it.

## References

- unbrowse contract `311771e1` ("EmergentDB prod-readiness")
- unbrowse contract `e65c7118` (server-side migration route)
- unbrowse memory `project_phase0d_browse_regression.md`
- unbrowse `backend/src/services/kv.ts:assertWithinSizeLimit` — the gate we maintain client-side
