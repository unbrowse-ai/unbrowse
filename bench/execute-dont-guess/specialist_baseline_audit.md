# Hard-reasoning 50→92 — baseline audit (honest scope)

This note resolves the open ‡ flag on the hard-reasoning row so the claim is **scoped,
not overclaimed** — the same discipline that corrected codebench's 25→100 to 68→100.

## What the witness actually measured (real, from `specialist_run.log`)

- The improved generalist (`unified_v2`) scores **92%** on the hard families and **100%**
  on the broad held-out set. That number is real and re-runnable (`specialist_witness.py`).
- The **50% "before" is a *trained specialist* baseline (`r1`)** — a model already trained
  on a reasoning slice — **not** the raw base model. The lift `50→92` is therefore
  *specialist-taught generalization* (a stronger specialist teaching a generalist), **not
  a raw-base→improved lift** of the kind codebench reports.

## The honest boundary (why this is flagged, not headlined)

- Whether the **raw base model** scores above r1's 50% on these hard families is
  **unverified**. By the codebench precedent, a *trained* baseline can be either stronger
  or weaker than raw base, so the true raw-base→improved delta could be smaller (or larger)
  than +42. We do **not** claim 50→92 as a raw-base lift.
- This is **not a raw-base lift**: it is a specialist→generalist transfer measured against a
  trained-specialist baseline. The 92% (and broad 100%) are the load-bearing, reproducible
  numbers; the 50→92 *delta* is reported with its baseline named.

## Where this is reflected

- `paper/execute-dont-guess.tex` carries the ‡ caveat (trained r1 baseline; raw-base
  comparison unverified / under audit).
- `paper/crypto-was-all-you-needed.tex` states it as "against a trained-specialist baseline,
  a scope we flag rather than overclaim."
- `bench/jespa/benchmarks-ledger.jsonl` / `REBENCH-UNBROWSE.md` record the same scope.

Verdict: the 92% / broad-100% are reproduced wins; the 50→92 *delta* is honestly scoped to a
trained-specialist baseline, not presented as a raw-base capability gain.
