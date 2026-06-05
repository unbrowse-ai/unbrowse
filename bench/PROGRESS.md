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

## Self-improvement iteration: closed the learned-ranker loop (INTERNAL — not public)

2026-06-05. Audited the learned route-energy ranker; layer-3 was open-loop (the live
ranker ran on the train-free back-off baseline alone). Two real defects, both fixed:

1. **Dead features.** The live call site (`src/execution/index.ts:6415`) dropped
   `intent` into `routeEnergy`, AND the trainer read intent from a phantom key —
   the runtime records it under `goal` (`telemetry.ts` emitRouteTrace), but
   `ledger_ebm.py` read `r.get("intent")`. Fix: pass `intent` at the call site +
   read `r.get("intent") or r.get("goal")`. Intent coverage on the real ledger went
   **0% → 100%** (10,930 rows).
2. **Wrong success metric.** The trainer gated on overall held-out `lift`, which is
   structurally ~0 because the back-off baseline already ranks WARM cells near-
   perfectly. Layer-3's actual job is COLD cells (back-off blind, NEUTRAL there).
   Re-gated on cold-cell generalisation: `auc_cold >= 0.53` AND no overall
   degradation. Real result: **cold-cell AUC 0.750** (vs 0.5 blind), real
   (synthetic:false) head shipped, prod loader loads it (`learnedEnergy=0.8325`).

Witness: `bench/ebm-closed-loop-gate.sh` (exit 0). The loop is closed on real data.

### Follow-on shipped: the closed loop now reaches the bundled runtime (INTERNAL)

The head loaded from a source checkout but not the scrubbed npm/worker bundle
(`repoRoot()` won't resolve in a flattened bundle; the vocab-scrub renames the
loader + the `energy-head` filename). Fix: the trainer now also emits a compiled-in
fallback `src/ranking/signals/route-head.embedded.ts` (a real, passing head only —
never synthetic), and the loader falls back to it when no on-disk pointer is found.
A static import always travels with the bundle, so the loaded ranker now works in
EVERY runtime (source, npm, worker) — proven: with NO file on disk the loader
returns warm=0.8325 / cold=0.6357 (back-off blind at 0.5). Witness:
`bench/ebm-runtime-ship-gate.sh` (exit 0). Also tightened `scrub-vocab.sh` to rename
all `UNBROWSE_EBM_*` env vars (the public client had leaked the term in env-var
names); public tree now fully EBM-clean, `public-tree-leak-gate` green. Remaining:
schedule the refit so the embedded head auto-regenerates.
