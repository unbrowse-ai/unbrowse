# Unbrowse — Benchmarks (reproducible, gated)

## Retrieval & execution layer

- **Anti-bot retrieval — 9/9 vs naive 0/9.** On a reproducible nine-post corpus across
  three communities of a major JavaScript-challenge-gated social platform — ground-truthed
  against the platform's own data — Unbrowse retrieves the real content on **9/9** posts
  where a naive HTTP client is blocked on **100%** of requests (HTTP 403). Re-runnable; it
  reports the naive-vs-Unbrowse head-to-head directly.
- **Latency & cost — 3.6× / 5.4× / 40×.** Peer-reviewed across 94 live domains:
  **3.6× mean / 5.4× median speedup, 40× fewer tokens**; on the API-native path
  ~30× faster and ~90× cheaper than driving a browser ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694)).

## "Execute, don't guess" — proven at model scale

The principle Unbrowse applies to the web — call the real API, don't have an agent
re-derive it — holds for models too: route to a real tool and execute, instead of
guessing from weights. A small on-device agent plus a library of executable tools beats
far larger weights on tool-routable tasks, every number backed by a re-runnable gate:

| task | result |
|---|---|
| code-correctness (route to a real executor) | **25% → 100%** |
| knowledge not in the weights (retrieve + execute) | **0% → 95%** |
| hard reasoning families (distilled routing) | **50% → 92%** |
| vs a 5×-larger model, no tools, on exact tasks | **100% vs 62%** |

The architecture is the capability — not the raw weights.
