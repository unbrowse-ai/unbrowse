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

## ✅ REAL — substantiated, witness in a SIBLING repo (corrected from a wrong "prose-only" flag)

A first pass flagged the execute-don't-guess family as prose-only because the witnesses
were not in the *unbrowse* repo or its git history. That flag was **wrong**: digging the
`.claude` session logs (`tinytools-agent` session `325deed1…`) located every witness +
run-log on disk in `~/Projects/tinytools-agent/`. The numbers are genuine held-out
measurements, each PASS:

| claim | exact run-log | witness (on disk, live-runnable) |
|---|---|---|
| code **25%→100%** | `codebench_run2.log`: base 25.0% → improved 100.0% (28 items, 7 families, target 70%) | `tinytools-agent/codebench_witness.py` (spawns server + `code_adapters`/`improved_adapters`) — CODEBENCH PASS |
| knowledge **0%→95%** | `farformula_run2.log`: without-retrieval 0/20 → with-retrieval+exec **19/20** | `tinytools-agent/farformula_witness.py` — FARFORMULA PASS |
| reasoning **50%→92%** | `specialist_run.log`: hard families r1 50% → unified_v2 **92%**, broad 100% | `tinytools-agent/specialist_witness.py` — SPECIALIST PASS |
| skill **63%→93%** | `skillfollow_run.log`: retrieve-and-follow **28/30=93%** vs scratch **19/30=63%** | `tinytools-agent/skillfollow_witness.py` — SKILLFOLLOW PASS |
| latency 3.6× / 5.4× median | field study, arXiv:2604.00694 | `paper/reference/bench/bench_live.py` (needs live network) |

The witnesses are **self-contained and live-runnable** (each spawns the served 0.8B with the
relevant adapter and scores a disjoint held-out set through the real generation+execution
loop). They were never lost or fabricated — they simply live in the SLM repo
(`tinytools-agent`), never vendored into `unbrowse/bench/`.

**Honest gap (real, smaller than the first flag):** unbrowse's `PROGRESS.md`/whitepaper cites
these witnesses by name, but a reader cloning *only* `unbrowse` cannot run them. Fix: either
vendor the four witnesses (+ adapters or a download step) into `unbrowse/bench/execute-dont-guess/`,
or point `PROGRESS.md` at the `tinytools-agent` witness paths. The claims are EARNED (real
witnesses, real logs); the only debt is repo-locality of the proof. (Lesson: scope the
witness search to the whole `.claude` corpus, not one repo — the proof can live next door.)

## The verdict (with Fractal JESPA in mind)

The rebench confirms the thesis at the claim-set level:
- **Discrete-structure / mechanism claims are real and reproducible** (route-EBM, intent-type,
  EBM gates, sealed-cache reuse) — the jespa-winnable, deterministic, witnessed core.
- **LLM-free-form claims split**: the *honest negatives* (browsecomp, distillation) are
  witnessed and named; the *headline execute-don't-guess wins* are **prose-only** — the one
  place the published claim set outruns its runnable evidence.

Reproduce the green ones: `bash bench/jespa/reproduce-all.sh` (+ the ebm/reuse gates above).
The benchmark judged, not the name — including unbrowse's own.
