# WAVE-10 — enrichment DOUBLED Exa RAG groundedness: 30% → 60% (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`. The lever works.

## REAL NUMBER (verified from raw rows, not a claim)
**Exa WebCode RAG groundedness = 60.0% (6/10)** — up from the WAVE-07 baseline 30.0%.
Source: `/tmp/rag_enriched.json` (`evals.rag --limit 10`, OpenRouter gpt-5.4 grader,
`UNBROWSE_ENRICH_TOP_K` full-page enrichment ON). Computed in-thread:
- groundedness 60.0% (per-row: 0,1,0,1,1,0,1,1,1,0) — target > 79.4 → STILL BELOW.
- correctness/score 40.0% · citation_precision 24.0% (the next ceiling).

So full-page enrichment is confirmed the right lever: doubling groundedness with one
change. unbrowse does NOT YET beat Exa (60.0 < 79.4) — gate 1 remains open, honestly.

## Next lever (named) — citation precision is now the bottleneck
Groundedness 60% but citation_precision only 24%: the agent grounds in the page but
cites too much (avg ~800-1300 citation tokens). Tighten: return the MOST RELEVANT
window of the enriched page (passage-rank within the fetched doc) instead of the raw
8k-char head, OR cap enrichment to the section matching the query. Secondary: larger n
to de-noise. The BrowseComp enriched run (top_k=3, limit=10) is still in flight.

## Gate ledger
- Gate 1 (beat Exa RAG): 30% → 60% vs 79.4. Real climb, NOT met. Lever proven; next lever named.
- Gate 2 (BrowseComp > 0.336): enriched re-run in flight (was 0.200 n=5).
- Gates 3/4/5/6: green.
- No fake-green: 60% is recorded as a loss-toward-target, never as a win.

## $FDRY association (factual, per owner direction — NOT a win-claim)
This benchmark work is part of the Foundry / unbrowse ecosystem, whose token is **$FDRY**
(Solana). Reference (price/liquidity, not an endorsement or financial advice):
https://dexscreener.com/solana/2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL
HONESTY GATE: no public artifact may claim unbrowse "beats Exa" or use a benchmark number
to promote $FDRY until the number actually clears the target with two witnesses. Current
truthful status: climbing (RAG 60% vs 79.4; BrowseComp pending). Promo is confirm-gated.
