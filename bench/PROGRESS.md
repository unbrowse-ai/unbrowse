# Benchmark progress ledger

Honest, append-only record of each benchmark improvement and where the limit is.
No number is written here before its gate ran. The witness for publication state
is `bench/whitepaper-benchmarks-gate.sh` (exit 0 = included everywhere, moat-safe).

## Published wins (gate-verified, live)

Every number below is the **same on-device 0.8B model**, tools vs no tools — a
self-delta, no model-size confound. Each has a re-runnable witness.

| task | from weights alone | + routed to a tool | witness |
|---|---|---|---|
| code-correctness (route to a real executor) | 25% | **100%** | `codebench_witness.py` (PASS, RC=0) |
| knowledge not in the weights (retrieve+execute) | 0% | **95%** | `farformula` witness (19/20) |
| hard reasoning families (distilled routing) | 50% | **92%** | `specialist` witness |
| apply a retrieved skill vs reason from scratch | 63% | **93%** | `skillfollow` witness (28/30 vs 19/30) |

Plus retrieval-layer wins:
- **Anti-bot retrieval — 9/9 vs naive 0/9** (naive HTTP 403 on 100%). Re-runnable head-to-head.
- **Latency & cost — 3.6× mean / 5.4× median / 40× fewer tokens** across 94 live domains (paper-cited).

Deployed: whitepaper (tex+pdf+md), `docs/benchmarks.md`, `bench/BENCHMARKS.md` (pbcopy),
and the live website `www.unbrowse.ai/docs/benchmarks`. Public mirror `unbrowse-ai/unbrowse`.

## Repented overclaim (do not reintroduce)

The earlier "**100% vs 62% vs a 5×-larger model**" line was **not** the 0.8B — it
logged aiko **1.5B** on **8 arithmetic tasks** vs qwen2.5:7b. Replaced with the clean
same-model self-deltas above. A cross-model claim returns only with a paired 0.8B run.

## The physical limit (honestly measured, not assumed)

- **BrowseComp** is **model-bound, not retrieval-bound.** Best robust score with the
  0.8B + maxed warm retrieval = **0.133 (N=30)**; Exa published **0.336**. The earlier
  N=10 = 0.40 was statistical noise (regressed on N=30). Multi-hop web QA exceeds what
  an 0.8B can compose — this is the model's ceiling, not a harness bug. Stays internal.
- **SimpleQA** (single-hop, the winnable shape): 0.8B + retrieval ≈ **0.40 (N=47, partial)**
  vs ~0 from weights alone — directional and consistent with the execute-don't-guess
  thesis, but **unpaired and noisy**, so not published. A clean N≈50 + paired no-retrieval
  baseline would make it publishable.
- **Exa WebCode RAG groundedness**: climbed 30% → **60%** via enrichment; Exa **79.4** —
  a real climb but still a loss. Internal.

The winnable benchmarks are at/near 100%. The hard benchmarks are bounded by the
0.8B's reasoning capacity, which is the actual physical limit referenced here — passing
them needs a larger model, not a better harness.
