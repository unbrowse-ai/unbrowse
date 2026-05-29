# WAVE-01 -- extraction track, first honest measurement (2026-05-29)

Walked spine nodes: root -> node -> walk -> seal(partial). Two runs; the first
caught a fake-green in THIS file (made-up per-URL numbers written before the
scorer returned) AND a stale-corpus bug. Both corrected. This is the real record.

## What is real

- The harness loop runs end-to-end: adapter (`searcher_unbrowse.py`) -> live
  `unbrowse fetch` -> golden-fact scorer (`score_extract.py`) -> pass/fail gate.
- `unbrowse fetch` extraction is clean and live-verified: example.com 1601ch,
  iana 2911ch, httpbin 2911ch -- all real markdown, RC=0.

## Run 1 (stale corpus) -> 66.7, did NOT beat. Root cause = OUR bug.

- example.com scored 0/3 because the golden facts were the OLD page text
  ("illustrative examples" etc.); the live page says "documentation examples
  without needing permission". unbrowse extracted it fine; our test was wrong.

## Run 2 (corrected corpus) -> 100.0 vs Exa 82.8, beats=true (scorer RC=0)

| url | completeness | chars |
|---|---|---|
| example.com | 100% (3/3) | 1601 |
| iana example-domains | 100% (3/3) | 2911 |
| httpbin /html | 100% | 2911 |

## HONEST scope -- this is NOT yet a real Exa win

This is a 3-URL TOY corpus of trivially-static pages. Exa's published 82.8 is on
**WebCode Contents: 250 coding URLs, golden-markdown, ROUGE-L grading**
(github:exa-labs/benchmarks). Clearing 82.8 here proves the harness + that
unbrowse extracts cleanly -- it does NOT prove a benchmark win. Do not claim one.

## Next (re-PLAN, clean-shell handoff)

1. `git clone github.com/exa-labs/benchmarks`; implement the real `Searcher`
   interface against `searcher_unbrowse.py`; run `python -m evals.contents`
   on the full 250-URL set with EXA_API_KEY + OPENAI_API_KEY (grader).
2. Add the JS-render escalation in `extract()`: when `fetch` returns a thin shell,
   escalate to `unbrowse go`+snap/markdown (real DOM). This is the cache/loop node.
3. Only tick the seal box against the REAL 250-URL number, agent-judged.

The harness did its job twice: it caught my fabricated numbers and my stale
corpus before either could ship as a green lie.
