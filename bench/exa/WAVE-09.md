# WAVE-09 — full-page enrichment lever BUILT + graded re-run launched (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`.

## The build (committed db2fb38aa)
`UnbrowseSearchEngine._enrich()` in `bench/browsecomp/unbrowse_browsecomp_searcher.py`:
for the top-k ranked DDG results, fetch the source page via the working `unbrowse fetch`
markdown path and replace the thin 1-2 sentence DDG snippet with the capped full body.
- OPT-IN: `UNBROWSE_ENRICH_TOP_K>0` (default 0 = OFF, so concurrent/peer runs unaffected
  and the default path is byte-identical to the prior committed adapter).
- `UNBROWSE_ENRICH_CHARS` caps the body (default 8000). Bounded by the SERP semaphore;
  honest fallback keeps the DDG snippet on fetch failure.
- Offline-verified: snippet 236 → 8000 chars on a content-rich Wikipedia page; 213 → 396
  on a sparse arxiv abstract page. Mechanism sound.

## Why (two-witness diagnosis, WAVE-08)
Both Exa-RAG and BrowseComp agents independently concluded search() feeds GOOD ranked
URLs (0 empty SERPs) — the loss is downstream: the agent never sees page bodies, so it
bails on multi-hop chains / misses the exact spec passage. Enrichment is the corroborated
single lever that should raise BOTH numbers.

## Graded re-run (in flight)
Enriched BrowseComp: `UNBROWSE_ENRICH_TOP_K=3 BROWSECOMP_LIMIT=10`, model
`openai/gpt-5-medium`, OpenRouter grader (comparable to Exa methodology). Background job.
Prior baseline to beat: BrowseComp 0.200 (n=5) → target 0.336.

## Honest gaps
- Exa RAG enriched re-run NOT yet done (the prior enrichment sub-agent hit the account
  session limit, resets 8pm Asia/Singapore; the Exa adapter `bench/exa/unbrowse_searcher.py`
  still needs the same _enrich treatment + a graded `evals.rag` re-run vs the 30.0% baseline).
- No box ticks until the enriched numbers land and are agent-judged. Gates 1/2 still NOT met.

## Note on collisions
A prior sub-agent left a half-applied edit that broke the adapter (reverted); the muonry
symbol-editor mismatched the docstring's `__call__` mention (reverted); a range edit
landed clean. Multiple concurrent loops touch this tree — git history is the source of
truth; the default path stays OFF so no in-flight run is disturbed.
