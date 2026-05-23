# EmergentDB issues — observed from unbrowse

This folder is the canonical drop zone for **EmergentDB issues that unbrowse
observes in production or during contract work**. Governed by contract
[`2dbdf6d6`](https://github.com/unbrowse-ai/unbrowse-dev) (loop-until): every
time a new EmergentDB issue surfaces in a `internal workflow` turn, a fresh `.md`
lands here AND a matching GitHub issue is opened on
[`justrach/emergentDB`](https://github.com/justrach/emergentDB).

## Filename convention

```
<YYYY-MM-DD>-<short-slug>.md
```

## File template

Each issue file MUST carry, in order:

1. One-line title with severity (P0 silent-data-loss / P1 broken-feature /
   P2 throughput-ceiling / P3 paper-cut).
2. Surface (the exact endpoint or behavior).
3. Source contract id from unbrowse's ledger.
4. Symptom — one paragraph, no speculation.
5. Reproduction — runnable `curl` or short shell snippet.
6. Observed output.
7. Expected output.
8. Why it matters (unbrowse-side impact, what we shipped as a workaround if
   anything).
9. Suggested fixes (any one, ranked).
10. References — file:line pointers into unbrowse source so Rach can see how
    we use the API.

The .md is intentionally diff-able and grep-able. Plain prose loses fidelity
in chat.

## Index (2026-05-23 wave)

| Local .md | GitHub | Status |
|---|---|---|
| [`2026-05-23-bug011-qdkv-silent-drop-over-10kb.md`](2026-05-23-bug011-qdkv-silent-drop-over-10kb.md) | [#4](https://github.com/justrach/emergentDB/issues/4) | **P1 OPEN** — real bug, lower priority for us after architecture clarification |
| [`2026-05-23-graph-search-returns-no-metadata.md`](2026-05-23-graph-search-returns-no-metadata.md) | [#5](https://github.com/justrach/emergentDB/issues/5) | **closed** — by-design per OSS source; SDK docs cleanup ask |
| [`2026-05-23-qdkv-rate-limit-blocks-bulk-migration.md`](2026-05-23-qdkv-rate-limit-blocks-bulk-migration.md) | [#7](https://github.com/justrach/emergentDB/issues/7) | **closed** — `/vectors/batch_insert` (1000/call) mitigates for our use |
| [`2026-05-23-architecture-clarification-emergentdb-by-design.md`](2026-05-23-architecture-clarification-emergentdb-by-design.md) | (internal) | clarification — EmergentDB qdkv is NOT a general KV; lean unbrowse arch documented |

All three reproduce against `https://api.emergentdb.com` as of
2026-05-23T04:00Z with the unbrowse `EMERGENTDB_API_KEY` (`emdb__...`).
