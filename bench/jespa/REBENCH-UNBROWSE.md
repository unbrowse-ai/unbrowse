# Rebench — unbrowse's whole claim set through the jespa-bench lens

The honest discipline (`skills/jespa-bench`): a published number is real only when a
runnable witness re-runs green. A number with no locatable witness is **prose-only until
proven** — not a lie, but not yet earned. Applied to *every* unbrowse benchmark claim.
Date: 2026-06-06.

## ✅ REPRODUCED — real witness, green now

| claim | metric | witness (re-runs green) |
|---|---|---|
| route-EBM retrieval | R@1 **0.0488, 4.6× base** | `ebllm/route_ebm_gate.sh` / `bench/jespa/…` |
| intent-type classification | acc **0.71–0.81, 2.1× base** (2 seeds) | `bench/jespa/intent-type-gate.sh` |
| EBM closed-loop (learned ranker ships) | cold-cell AUC 0.750 vs 0.5 | `bench/ebm-closed-loop-gate.sh` ✅ |
| EBM runtime-ship (embedded head loads) | warm 0.83 / cold 0.64 | `bench/ebm-runtime-ship-gate.sh` ✅ |
| sealed-cache reuse | **92× speedup** (mechanism demo) | `paper/reference/bench/bench_reuse.py` ✅ |
| the cross primitive | `jepa(jepa)=jepa` 0.99998, breaks@7 | `jesus-pattern/jepa selftest` ✅ |

These are the **discrete-structure / mechanism** claims — exactly where Fractal JESPA says
a learned energy + a content-addressed cache win. They stand on their own evidence.

## ✅ HONEST NEGATIVES — witnessed, show the real limit (not faked)

| claim | result | witness |
|---|---|---|
| BrowseComp (0.8B multi-hop) | **0/15** (model reasoning limit) | `bench/browsecomp/browsecomp-gate.sh` (needs key) |
| LLM distillation (SFT) | base beats distilled **18–10** | `aiko-claude-distill/scripts/before_after_eval.py` |
| filtered re-distill | base beats distilled **17–8** | (lean SFT + eval) |
| energy-rerank of base | = random, **lift +0.000** | `aiko-claude-distill/scripts/jespa_rerank.py` |
| public route-retrieval (101) | keyword beats jespa | `bench/jespa/jespa_route.py` |

The LLM/free-form side: honestly reported failures and ceilings, the inverse of Goodharting.

## ⚠️ PROSE-ONLY — headline number, NO runnable witness found (the flag)

| claim | source | status |
|---|---|---|
| **execute-don't-guess: code 25%→100%** | `bench/PROGRESS.md`, whitepaper | witness `codebench_witness.py` **NOT in repo or git history** |
| **knowledge-not-in-weights: 0%→95%** | same | witness `farformula` **not found** |
| **hard-reasoning: 50%→92%** | same | witness `specialist` **not found** |
| **apply-skill: 63%→93%** | same | witness `skillfollow` **not found** |
| latency 3.6× mean / 5.4× median | `paper/internal-apis…tex`, arXiv:2604.00694 | field study; `bench_live.py` needs live network (not a unit witness) |

`git log -S 'codebench_witness'` shows the script *names* were only ever added to
`PROGRESS.md` **prose** — the scripts themselves were never committed. So unbrowse's most
prominent headline ("execute, don't guess: 25%→100%") currently has **no reproducible
witness on disk**. It may be true (it's a plausible, gate-shaped claim), but per the
discipline it is **unearned until a runnable scorer exists**.

**Honest fix (not done here — flagged):** either restore/commit the four execute-don't-guess
scorers so the headline numbers re-run green, or soften the whitepaper/landing to "field-
measured, witness pending." Don't ship a headline whose gate can't be run.

## The verdict (with Fractal JESPA in mind)

The rebench confirms the thesis at the claim-set level:
- **Discrete-structure / mechanism claims are real and reproducible** (route-EBM, intent-type,
  EBM gates, sealed-cache reuse) — the jespa-winnable, deterministic, witnessed core.
- **LLM-free-form claims split**: the *honest negatives* (browsecomp, distillation) are
  witnessed and named; the *headline execute-don't-guess wins* are **prose-only** — the one
  place the published claim set outruns its runnable evidence.

Reproduce the green ones: `bash bench/jespa/reproduce-all.sh` (+ the ebm/reuse gates above).
The benchmark judged, not the name — including unbrowse's own.
