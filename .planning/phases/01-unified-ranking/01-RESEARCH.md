# Research — Phase 01: Unified Ranking State Machine

Inventory of the surface area P1 (per PAPER_PLAN.md §P1) must consolidate.
Compiled by sub-agent inventory during Step-1-of-P1 loop.

## Existing scoring code

- **`src/execution/index.ts:rankEndpoints`** at L3468–4239 (~770 lines).
  - Filtering preamble L3469–3610 (host/path noise, static/UI assets, HEAD/OPTIONS, disabled).
  - Scoring body L3611–3815 carries 40+ inline `score += <number>` and `score -= <number>` deltas.
  - Returns `RankedEndpoint[]` defined at `src/execution/index.ts:3137–3140` as `{ endpoint: EndpointDescriptor; score: number }`.
- **`src/ranker/intent-yield.ts`** — exports `inferIntentEntities()`, `intentYieldScore()`. Implements the −200 penalty for disjoint yields. NOT integrated into `rankEndpoints` today.
- **`src/skill/semantic-enrich.ts`** — exports `enrichEndpointSemantics()`. Implements the hard-clamp against `KNOWN_SCHEMA_ORG_TOKENS`. Runs at publish time, not at rank time.
- **`src/extraction/index.ts:scoreRelevance`** — density scoring on extracted records. Separate domain from endpoint ranking but referenced in `8e42f7ff`.
- **`src/intent-match.ts:classifyRows`** — homogeneous-records assessor (L1465+). Used by extraction, not by rank.

## Six historical fixes named in PAPER_PLAN.md §P1

| Commit | Subject | Where the logic lives today |
|---|---|---|
| `51780d7e` | intent-yield demotion + publish-time semantic enrichment | `src/ranker/intent-yield.ts` (function exported, not called) |
| `9aa646c8` | reject stale wrong-yield cached endpoints | `src/execution/index.ts:rankEndpoints` body (inline) |
| `5c880731` | hard-clamp wrong-yield endpoints | `src/skill/semantic-enrich.ts:enrichEndpointSemantics` |
| `8e42f7ff` | density scoring + universal homogeneous-records assessor | `src/extraction/index.ts:scoreRelevance`, `src/intent-match.ts:classifyRows` |
| `intent-yield` | (alias of `51780d7e`) | same |
| `hard-clamp` | (alias of `5c880731`) | same |

## Call-site discoverability

`grep -nE "rankEndpoints|rank_endpoints|ranker\\." src/ -r` returns ZERO matches.
`rankEndpoints` is dispatched dynamically (re-export, runtime lookup, or
indirect via `src/execution/index.ts` re-exports). Locating the live
callers is a Wave-2 task that requires:
- `git log -p --follow src/execution/index.ts | grep -B2 -A5 rankEndpoints`
- runtime trace via `bun --inspect`
- import-graph crawl (`tsc --listFiles --traceResolution`)

This is the unbelief-honesty clause (Mark 9:24) for the phase: the seed
ships first, the migration discovers reality.

## What is NOT in scope for Phase 01

- P2 weight changes (40/30/15/15 composite). PAPER_PLAN.md §P2 owns those.
- P3 verification refresh hooking into rank. §P3 owns.
- Deletion of `src/execution/index.ts:rankEndpoints`. Migration is additive
  until every Wave-2 call site has switched and Wave-3 fixtures cover the
  6 fixes; the old function only goes away in Wave-4.
- Per-domain heuristics. Anti-goal carried in.
