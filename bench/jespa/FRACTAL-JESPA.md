# Fractal JESPA — unbrowse as the tools inside the energy ranker

> One energy, at every scale. JESPA (the joint-embedding predictive cross) is the
> *selector*; unbrowse's routes are the *tools* it selects among and fires. The same
> `predict-the-target's-latent → rank-by-energy` shape recurs from picking the next route,
> to classifying a route's access-pattern, to the cross folding on itself — fractal.

## The architecture

```
                          JESPA  (energy ranker / cross)
                 predict target latent → score by energy → fire lowest
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                           ▼
   resolve(intent)          classify(route)              cross(self)
   energy-rank the          energy-rank the              jepa²=PᵀP self-loop
   candidate UNBROWSE        access-pattern type          to the fixed point
   routes (the tools)        (anchor/ssr/graphql/…)       (the god particle)
        │                          │                           │
        ▼                          ▼                           ▼
   unbrowse EXECUTE          unbrowse CAPTURE             remember (grace-loop:
   the chosen route          when no route exists         proven node rests-loops)
   → real data
```

- **unbrowse = the tools** (the leaf actions): `resolve` (intent → ranked route shortlist),
  `execute` (route → real data), `capture` (browser when no route exists). Already shipped:
  the live ranker is energy-based (`routeEnergy`, `src/execution/index.ts:6415`).
- **JESPA = the selector** that decides *which* tool/route fires: encode the intent, predict
  the route's latent, rank candidates by energy, fire the lowest. This is the route-EBM,
  measured below.
- **Fractal**: the identical energy shape recurs — route selection, type classification, and
  the cross folding on itself (`jepa²=PᵀP → god particle`). Self-similar all the way down.

## The reproducible scorecard (real numbers, every one re-runnable)

Run everything: `bash bench/jespa/reproduce-all.sh` (gate exits 0 on the genuine win count).

| level | what JESPA does | metric | jespa | baseline | verdict | witness |
|---|---|---|---|---|---|---|
| **route select** | energy-rank unbrowse routes for an intent | R@1 / 99 distractors | **0.0488** | 0.0106 | ✅ **4.6×** | `ebllm/route_ebm_gate.sh` |
| **route classify** | energy-classify a route's access-pattern | acc / 7-class | **0.71–0.81** | 0.32–0.39 | ✅ **2.1×** | `bench/jespa/intent-type-gate.sh` |
| **cross (self)** | jepa² folds to the god particle | `jepa(jepa)=jepa` cos | **0.99998** | — | ✅ settles, breaks@7 | `jesus-pattern/jepa selftest` |
| **plank vs cross** | the two self-fixed-points are distinct | cos(plank*,cross*) | **0.6334** | — | ✅ distinct | `aiko-claude-distill/scripts/distill_plank_cross.py` |
| LLM distill (SFT) | move student weights to teacher | A/B vs teacher | 0.33 | 0.60 | ❌ base wins 18–10 | `before_after_eval.py` |
| LLM distill (filtered) | re-distill on /jespa-filtered corpus | A/B vs teacher | 0.27 | 0.57 | ❌ base wins 17–8 | (lean SFT + eval) |
| LLM rerank | cross energy picks among base candidates | A/B vs random | 0.25 | 0.25 | ❌ lift +0.000 | `aiko-claude-distill/scripts/jespa_rerank.py` |

## The thesis (proven from both sides)

**JESPA energy is a discrete-structure ranker — the right selector for unbrowse's tools,
the wrong tool for free-form prose.**
- ✅ Where candidates have separable structure (routes, access-pattern types), the energy
  wins big (4.6×, 2.1×). This is exactly the "unbrowse-as-tools-inside-jespa" loop.
- ❌ On free-form LLM text it gives nothing: SFT distillation degrades a strong instruct
  base (the plank collapses to corpus boilerplate, `cos 0.63` from the cross), and the cross
  energy can't discriminate answer quality (rerank = random, lift +0.000).

So the fractal stops at the tool boundary: JESPA picks **which unbrowse route/tool** to fire
(it wins there); it does **not** replace the LLM that writes prose (it has no signal there).

## Reproduce — every artifact, every command

```bash
# 0. the JESPA cross primitive (jepa(jepa)=jepa, breaks at 7, catches degenerate ops)
cd ~/Projects/jesus-pattern && ./jepa selftest

# 1. WIN — unbrowse routes as tools: energy ranks the true route (4.6x base)
cd ~/Projects/ebllm && bash route_ebm_gate.sh        # extract 8205 real traces → train → R@1

# 2. WIN — energy classifies a route's access-pattern (2.1x base)
cd ~/Projects/unbrowse-ecosystem/unbrowse && bash bench/jespa/intent-type-gate.sh

# 3. the plank→cross geometry (why distillation collapses; the two roads)
DISTILL_CORPUS=~/Projects/aiko-claude-distill/data/claude_traces.jsonl \
  python3 ~/Projects/jesus-pattern/skills/jesus-pattern/references/examples/jepa_build/distill_plank_cross.py --selftest

# 4. the honest negatives (LLM side) — reproduce the four that DIDN'T beat base
cd ~/Projects/aiko-claude-distill
ADAPTER_NAME=claude_distill EVAL_N=30 python3 scripts/before_after_eval.py   # SFT: base wins
EVAL_N=20 N_CAND=4 python3 scripts/jespa_rerank.py                            # rerank = random

# 5. the accumulating ledger-gate (genuine reproduced-win count = 2)
JESPA_WIN_TARGET=2 bash bench/jespa/jespa-benchmarks-gate.sh                  # exit 0
```

## The pieces (where each lives)

- **Selector (JESPA):** `jesus-pattern/skills/sp-jepa/SKILL.md` (the 10-atom map + JESPA
  section + two-roads + geometry), engine `…/jepa_build/jepa.py`, primitives `jespa`,
  `jespa_cross.py`, `distill_plank_cross.py`, `remember_the_cross_gate.sh`.
- **Tools (unbrowse):** live energy ranker `src/ranking/signals/learned-energy.ts`
  (`routeEnergy`), call site `src/execution/index.ts:6415`; route-EBM `~/Projects/ebllm`.
- **Benchmark harness:** `bench/jespa/` (ledger + gate + intent-type + jespa_route), the
  reusable method skill `jesus-pattern/skills/jespa-bench/`.
- **The geometry papers (secular):** `manicmind/frontier/frontier-{2,4}-*.md`.

The benchmark judged, not the name: 2 real wins (unbrowse-as-tools), 4 honest negatives
(LLM-as-jespa), one clean thesis. Fractal where the structure is discrete; honest where it
isn't.
