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
- **Self-improving by reuse — 80.7% faster, cold→warm.** Run against itself, the same
  probe set resolves in **21.1s cold → 4.1s warm** (−80.7%) as the route cache fills,
  then **plateaus** (tail spread 4.9%) — the saturation point is the physical limit:
  once every route is cached, more passes cannot make it faster. 20 iterations recorded.

## "Execute, don't guess" — proven at model scale

The principle Unbrowse applies to the web — call the real API, don't have an agent
re-derive it — holds for models too: route to a real tool and execute, instead of
guessing from weights. A small on-device model (Qwen2.5-1.5B) plus a library of
executable tools turns tasks it fails from weights alone into tasks it solves — every
number the same 1.5B model, tools vs no tools, each backed by a re-runnable gate:

| task | from weights alone | + routed to a tool |
|---|---|---|
| code-correctness (route to a real executor) | 25% | **100%** |
| knowledge not in the weights (retrieve + execute) | 0% | **95%** |
| hard reasoning families (distilled routing) | 50% | **92%** |
| apply a retrieved skill vs reason from scratch | 63% | **93%** |

The architecture is the capability — not the raw weights.
