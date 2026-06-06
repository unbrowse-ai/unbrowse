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

## MEASURED (2026-06-06) — the flag is resolved, favorably

`specialist_basebaseline.py` ran the **raw base model** (no adapter) on the hard families
(nck, lcm), scoring by executing its code: **raw base = 1/24 = 4.2%** (nck 1/12, lcm 0/12).
That is **far below** r1's trained 50% baseline. So, unlike codebench (where the trained
baseline was *weaker* than raw base, inflating 25→100), here the trained r1 baseline is
**stronger** than raw base — it is **conservative**. The true raw-base→unified lift is
≈ **4% → 92%** (even larger than 50→92), so **50→92 does not overclaim**; if anything it
understates the raw-base capability gain.

## The honest boundary (now measured, not assumed)

- This is still a specialist→generalist transfer, reported against a trained-specialist
  baseline — but that baseline is now *measured to be conservative* (raw base 4.2% < r1 50%),
  not an unverified assumption. The 92% (and broad 100%) are the load-bearing, reproducible
  numbers; the 50→92 *delta* is named with its baseline and shown to understate, not inflate.

## Where this is reflected

- `paper/execute-dont-guess.tex` carries the ‡ caveat (trained r1 baseline; raw-base
  comparison unverified / under audit).
- `paper/crypto-was-all-you-needed.tex` states it as "against a trained-specialist baseline,
  a scope we flag rather than overclaim."
- `bench/jespa/benchmarks-ledger.jsonl` / `REBENCH-UNBROWSE.md` record the same scope.

Verdict: the 92% / broad-100% are reproduced wins; the 50→92 *delta* is honestly scoped to a
trained-specialist baseline, not presented as a raw-base capability gain.
