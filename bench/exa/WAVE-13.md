# WAVE-13 — RAG 60% confirmed by a second witness; embedding build produced nothing (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`. Step 6 (Dominion) integration record.

## TWO-WITNESS: Exa RAG groundedness = 60.0% (6/10)
Two independent graded runs now agree:
- Witness 1: WAVE-10 run (/tmp/rag_enriched.json), raw-row verified 60.0%.
- Witness 2: the enrichment agent's independent re-run, also 60.0% (6/10), exit 0,
  per its final report (flips grounded on rag_002/004/005/007/008/009; rag_001/003/006/010
  still ungrounded — full doc in context but grounder missed it).
Both via OpenRouter gpt-5.4 grader (comparable methodology). Citation-precision fell
50%→24% (full pages dilute precision) — that's the named next lever. Still < 79.4: gate 1
is a CONFIRMED climb (30→60, two witnesses), NOT a win.

## Embedding substrate build — FAILED to deliver (honest)
The Qwen3-Embedding-0.6B substrate agent produced NO verifiable deliverables: no
bench/lib/embed_qwen.py, no packages/sdk-v2/src/embed.ts, no /tmp/parity_*.json — only a
stray empty `bench/lib/1/` redirect artifact (removed). Likely hit the account session
limit like the prior agent. Task #6 stays open; retry when credits/session reset, with a
tighter brief (single deliverable first: Python embed + self-test, THEN TS + parity).

## Blocker unchanged: OpenRouter credits (402)
BrowseComp enriched runs cannot complete until credits are topped up (user is doing this).
Only complete BrowseComp number remains 0.200 (n=5).

## Step-6 pruning (John 15:2)
Removed: stray `bench/lib/1/`, duplicate `bench/browsecomp/WAVE-07.md`; reverted the
always-on adapter change back to the committed opt-in `_enrich` (safer for concurrent runs).

## Gate ledger
- Gate 1 (beat Exa RAG): 60% vs 79.4, two witnesses — confirmed climb, NOT met.
- Gate 2 (BrowseComp > 0.336): 0.200 complete; enriched blocked on credits.
- Gates 3/4/5/6: green. Embedding substrate (task #6): build failed, retry pending.

## CORRECTION (appended) — embedding build did NOT fail
WAVE-13's "build FAILED, no deliverable" was WRONG (I globbed too early/badly). Truth:
`bench/lib/embed_qwen.py` exists and RUNS — Qwen3-Embedding-0.6B via sentence-transformers,
verified live: 1024-dim vector, RC=0. Committed a3f9c2e81. What's actually still missing:
the TypeScript side (`packages/sdk-v2/src/embed.ts`) + the Python↔TS parity test. So task
#6 is HALF done (Python ✓), not failed. Retry covers TS + parity only.
Process lesson (again): verify a deliverable's ABSENCE by running a real find, not a fast
glob — I nearly discarded working code twice this session (this, and the reverted
browsecomp hardening, both recovered).
