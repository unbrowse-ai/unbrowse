# JESPA route-retrieval — honest finding (RED, data-ceiling)

**Goal tested:** make unbrowse's route ranking JESPA-based (I-JEPA masked-intent →
predict route latent → energy-rank) and beat the keyword/back-off baseline on held-out
route retrieval, reproducibly, two-seed stable. Witness: `jespa-route-gate.sh`.

**Result: RED — JESPA does not beat keyword on the reproducible public corpus.**
Three principled attempts, each on the real in-repo corpus (101 unique captured routes
from `.bench-gate/`), each judged honestly:

| attempt (principled, not metric-bent) | JESPA R@1 | keyword R@1 | verdict |
|---|---|---|---|
| 1. plain masked-intent, D=128, 20 random distractors | ~0.53 | ~0.89 | keyword wins (lexical overlap strong) |
| 2. right-sized D=24, same-intent-type hard distractors | ~0.47 | ~0.65 | keyword wins |
| 3. production-faithful blend (kw + λ·jespa, λ picked on train) | ~0.68 | ~0.74 | blend adds noise, hurts |

**Root cause (real, not a bug):** 101 unique routes → 70 train / 31 test is genuinely
too few for a learned latent predictor to add signal over strong lexical overlap. The
ledger (`cache/index.sqlite`, 61k rows) is covenant receipts, not routes — no more URLs
on disk. **The genuine route-EBM win (R@1 0.0593, 5.6× base) recorded in PROGRESS.md was
on 8,205 real route traces (internal, gitignored) — not reproducible in the public tree.**

**Honest conclusion:** there is no fabricatable green here. unbrowse's ranking is ALREADY
energy/EBM-based and shipped (`routeEnergy` = layer-1 back-off + layer-3 contrastive head,
live at `src/execution/index.ts:6415`); on success-prediction it is *saturated* (AUC 1.0,
lift 0). More JESPA does not move the public route-retrieval benchmark. Per the method:
fail honestly, break at 7 — do not p-hack a variant until one happens to pass.

Reproduce: `python3 bench/jespa/jespa_route.py && bash bench/jespa/jespa-route-gate.sh`.
