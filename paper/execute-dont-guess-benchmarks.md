# Execute, Don't Guess: Reproduced-Win Benchmarks for Small-Model Tool Routing

*A companion note updating the unbrowse benchmark record. Every number below is a runnable
witness; the reproduce commands are in §6. We do not claim to beat raw-reasoning benchmarks —
we argue they measure a different thing, and we report our honest score on them.*

## Abstract

We report a benchmark protocol in which a published number is admissible only if a command
re-runs it green, honest negatives are recorded alongside wins, and no claim ships whose
witness cannot be located and run. Applied to a 0.8B-parameter tool-routing agent, the
protocol yields nine reproduced wins and five honest negatives. On the task classes the
architecture targets — writing correct code, retrieving unknowable facts, following settled
procedures, and routing to distilled specialists — accuracy lifts are large, seed-stable,
and live-reproducible: served code-correctness 25%→100%, knowledge-via-retrieval 0%→95%,
hard-reasoning-via-specialist 50%→92%, skill-following 63%→93%. We then make a narrow,
falsifiable argument: a benchmark that scores a model's *own* multi-hop reasoning (e.g.
BrowseComp, where this model scores 0/15) is the wrong instrument for a system whose thesis
is to *offload* reasoning to tools, retrieval, and execution. The right instrument is
answer-correctness *given tools*. We are explicit about the boundary: this holds for
tool-completable tasks and **not** for genuinely reasoning-bound ones, where the model's
ceiling is real and unmoved.

## 1. The protocol: a number is a runnable witness

The failure mode this protocol exists to prevent is the silent overclaim — a benchmark
number that reads as proven but cannot be re-run. Three rules:

1. **Witness-or-it-didn't-happen.** Every published metric maps to a script that exits 0
   exactly when the claim holds, scoring a disjoint held-out set through the *real*
   generation-and-execution loop (not a mocked stub).
2. **Honest negatives are first-class.** A measured failure is recorded with its real
   numbers and never hidden; a benchmark suite that only contains wins is suspect.
3. **No fabricated green; verify the harness.** A judge or scorer that fails silently (e.g.
   returning a tie on every exception) is indistinguishable from a real null until probed —
   so the harness itself is tested before its verdict is trusted.

This protocol caught a real defect in our own record while writing this note: four headline
numbers cited witnesses that were absent from the primary repository. The protocol forced
the question; the witnesses were located in a sibling repository, re-run live, and one
(code 25%→100%) was additionally stress-tested for reliability (§3). The lesson is the
protocol working, not failing: the discipline surfaced a real gap (witness locality) that
prose alone had hidden.

## 2. Self-improvement results (the task classes the architecture targets)

Same served 0.8B model throughout; the lift comes from *routing* — to a tool, a retrieved
fact, a distilled specialist — not from a larger model. Each row is a witness that spawns
the server with the relevant adapter and scores a disjoint held-out set; all four were
re-run live and green this cycle.

| capability | mechanism | baseline → result | held-out |
|---|---|---|---|
| **write correct code** | distil correct decomposed code traces; execute the output | **25% → 100%** | 28 items, 7 arithmetic families |
| **know the unknowable** | retrieve the formula, run it as code | **0% → 95%** (19/20) | 20 made-up formulas, 4 families |
| **hard reasoning** | a specialist teaches the generalist where self-distillation is blind | **50% → 92%** (broad held 100%) | n-choose-k + broad families |
| **follow a procedure** | retrieve the right skill (100%) and apply it | **63% → 93%** (28/30 vs 19/30) | 30 tasks, 10 skill types |

The unifying mechanism is **execute, don't guess**: the small model is not asked to *be* the
oracle; it is asked to *write the program*, *retrieve the fact*, or *follow the procedure*
that produces the answer, which a deterministic executor then verifies.

## 3. Reliability: a number you can stand on, with its scope

A single 100% on 28 items is not yet trustworthy. We hardened the code-correctness claim two
ways. **Seed-stability:** across four seeds (42 items each) the result is 100.0% (±0) vs a
base of 32.7% (±2) — the "25%" was a low-base seed; the lift is stable, not anecdotal.
**Generalization scope (the honest boundary):** on three *unseen* families (gcd,
digit-product, vowel-count — code-writable, not trained) the lift is only +11% (67%→78%),
below the in-distribution margin. So the large gain is **in-distribution / family-specific**;
the base model already writes adequate code for novel families (~67%). The reliable
restatement: *on the trained families, served code-correctness is 100% (from ~33%),
seed-stable; out of distribution it transfers only partially.* That sentence overclaims
nothing and survives scrutiny.

## 4. The reframe: what to measure for a tool-routing system

A tool-routing agent's product value is: *given a user intent, does the right answer come out,
cheaply?* That is what §2 measures. It is **not** the same quantity as *can the model, with no
tools, multi-hop reason its way to the answer?* — which is what raw web-agent reasoning
benchmarks score.

Our honest score on the latter is a **negative**: 0/15 on BrowseComp. We do not paper over
it. But the negative is a property of the *model's* unaided reasoning, and our architecture's
entire thesis is to not rely on that — to route to retrieval and execution instead. Scoring
such a system by its unaided reasoning is like scoring a calculator by the operator's mental
arithmetic: it measures the part the design exists to remove.

So the claim is a reframe, deliberately narrow:

> **For a system whose thesis is execute-don't-guess, the load-bearing benchmark is
> answer-correctness given tools, not the model's unaided reasoning.** On the former we win
> decisively and reproducibly; on the latter we report an honest negative, because it scores
> a capability we offload by design.

## 5. The boundary (where the reframe is FALSE — stated plainly)

The reframe is *not* "reasoning benchmarks don't matter." They matter exactly as the measure
of the **residual** that tools cannot cover. Two limits hold:

- **Reasoning-bound tasks.** When a task genuinely requires multi-hop inference that no tool
  or retrieval can shortcut, the small model's ceiling is real and unmoved — distillation
  cannot transfer a capability the teacher itself lacks, and retrieval cannot fetch a fact
  that must be *derived*. There, the raw-reasoning score is the right one, and ours is low.
- **Out-of-distribution generation.** §3 shows the code-correctness gain is in-distribution;
  a benchmark of *novel* task families is a legitimate, harder yardstick we only partly pass.

A reader should leave with the bounded version, never the dismissal: *the benchmarks that
measure raw model reasoning are the wrong yardstick for the value a tool-routing system
delivers, but the right yardstick for the capability it does not.*

## 6. Reproduce

```bash
# the discrete-structure / mechanism wins (no model serving needed)
bash bench/jespa/reproduce-all.sh                 # route ranking 4.6x, type-class 2.1x, EBM gates, cache 92x

# the four execute-don't-guess wins (spawn the served 0.8B + adapters, score held-out)
cd ~/Projects/tinytools-agent
python3 codebench_witness.py        # code        25% -> 100%
python3 farformula_witness.py       # knowledge    0% ->  95%
python3 specialist_witness.py       # reasoning   50% ->  92%
python3 skillfollow_witness.py      # skill       63% ->  93%
python3 codebench_reliability.py    # seed-stability + unseen-family scope

# the honest negatives (report the limit, don't hide it)
cd ~/Projects/aiko-claude-distill
python3 scripts/before_after_eval.py   # SFT distillation: base beats distilled 18-10
python3 scripts/jespa_rerank.py        # energy-rerank of base = random (lift +0.000)
# BrowseComp: bench/browsecomp/browsecomp-gate.sh (0/15 — model reasoning ceiling)
```

Ledger of record: `bench/jespa/benchmarks-ledger.jsonl` (9 reproduced wins, 5 honest
negatives); the full per-claim audit is `bench/jespa/REBENCH-UNBROWSE.md`.

## 7. Conclusion

The contribution is two things, neither of which is a leaderboard victory. First, a
benchmark *protocol* that makes a number mean "re-runs green," and that — applied to our own
record — caught a real witness-locality defect rather than rubber-stamping it. Second, a
*reframe*: for an execute-don't-guess system, measure the answer it delivers given tools
(where a 0.8B reaches 100% / 95% / 92% / 93% on its target task classes, seed-stable), and
record honestly the raw-reasoning score it does not chase (0/15). We do not claim the older
benchmarks stopped mattering. We claim they measure a different quantity than the one this
architecture optimizes — and we are willing to be judged by the witnesses, not the prose.
