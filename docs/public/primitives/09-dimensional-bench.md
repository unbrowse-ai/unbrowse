# Dimensional bench

## The rule

Bench coverage is measured across seven capability dimensions, not as one aggregate number. A release does not clear the deploy gate's STAGE-2 child until every dimension shows 100% pass.

The seven dimensions:

| Axis | What it measures |
|---|---|
| **INDEX** | A captured route is correctly classified as a real API endpoint, not a tracking beacon, ad collector, or config endpoint. |
| **AUTH** | Auth headers (Authorization, Cookie, X-Api-Key) are extracted at capture time and replayed at execute. |
| **CSRF** | CSRF tokens or nonces are discovered from HTML or a prior request and replayed. |
| **SEARCH** | A query parameter is recognized; the calling agent fills `{q}` (or the equivalent slot) from the natural-language intent. |
| **RETR** | Execute returns real content matching the intent. Not boilerplate, not a captured-error body, not the wrong template's result. |
| **EXEC** | A paid execute fires the right endpoint with the right method and body. No write on a read. |
| **META** | The operation graph walks dependencies (requires / yields chain from the trace store) correctly. |

## How it composes

`harness/probes/corpus-dimensional.txt` tags each probe with its primary dimension. Lines marked `@class: antibot` are reported separately and do not count against the dimensional totals (their failure mode is a capability gap that the residential proxy fallback closes, not a dimensional one). Lines marked `@class: auth-gated` are also reported separately because they require the user to have a valid cookie in the local vault; without one, the probe cannot honestly measure product capability and would otherwise inflate the dimensional FAIL count.

`scripts/bench-dimensional-summary.sh` reads the corpus plus `.bench-local/results.jsonl`, joins by URL, and prints the per-axis pass-rate table:

```
AXIS      PROBES  MEASURED  PASS  FAIL  PASS-RATE
--------------------------------------------------
INDEX          4         4     4     0     100.0%
AUTH           3         3     3     0     100.0%
CSRF           3         3     3     0     100.0%
SEARCH         3         3     3     0     100.0%
RETR           5         5     5     0     100.0%
EXEC           2         2     2     0     100.0%
META           2         2     2     0     100.0%
```

When that table reads 100% across every row, STAGE-2 of the deploy gate is satisfiable. Until then, the gate refuses and the release flow exits at the gate's `before:init` hook.

## Why per-dimension and not aggregate

Aggregate pass rate hides which capability is broken. A release that hits 95% overall but has 0% AUTH is not a release we ship. The per-dimension table makes the broken axis visible at the gate.

Aggregate-first thinking also lets a regression in one axis hide behind improvements in another. Per-dimension thinking requires every axis to hold.

## What this rules out

- A single percentage number passed as "bench coverage" that conflates seven independent capabilities.
- Marking the deploy gate's bench stage satisfied because the overall rate is high while a specific axis is low.
- A bench-corpus row that exercises no specific dimension. Every probe in the dimensional corpus declares its axis on its line.
- A probe tagged with one axis being counted under another. The aggregator counts each probe under exactly the axis declared in the corpus.
