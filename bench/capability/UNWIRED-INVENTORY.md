# Unwired-inventory & disposition (jesus-loop, 2026-06-16)

The grain-of-wheat audit (John 12:24): a mechanism built but never *called* in the living
path bears no fruit until wired. A parallel cold reader (Explore agent) surfaced candidates;
each was then **re-verified by git-grep for real production call-sites** before disposition
(Prov 18:17 — the cold read alone is the apophenia trap; 3 of its claims were false).

Disposition = `WIRED` | `dormant-because-<X>` | `bug-queued` | `pruned`.

## Verification method
`git grep -n "<fn>(" -- 'src/**/*.ts' ':!*.test.ts' ':!**/tests/**' ':!bench/**'`, minus the
definition line and comments → a real production caller, or zero (genuinely buried).

## Ranked dispositions

| # | mechanism | file:line | prod callers | disposition |
|---|---|---|---|---|
| 1 | `cachedResolution.dependsOn` / `.pointer` | `src/values/cached-resolution.ts:42,52,71` | **now 1** (this loop) | **WIRED** — `walkPrerequisiteChain` (orchestrator/index.ts) persists each prereq via `cachedResolution(principal, dependsOn=[priorPointer], cacheable)`; witness `test_persistent_cascade_walk.ts` 17/17, mutation-proven. |
| 2 | unfilled-`{param}` leak (no pre-fetch hole guard, direct path) | `src/execution/index.ts:3311` (`interpolate`→fetch); guard only at `:3709` recipe-replay | n/a (a hole, not an export) | **bug-queued (own loop — hazard-mapped below)** — a literal `{param}` survives into the fetched URL when a hole is unbound on the DIRECT execute path. `:3482` handles SURPLUS params (appends as query), NOT missing ones. Real, unguarded. |

### Item #2 hazard map (why it is its own loop, not a one-pass tail)
The bail vessel exists — the session-bound gate at `:2814` returns `success:false` BEFORE the
fetch, the exact shape a hole-guard should mirror. But every surgical option collides with a
live mechanism, so each needs its own red→green witness:
- **bail-early on leftover `/{\w+}/`** — but today holes→`shouldReplayRecipe` skips replay→the
  **probe ladder re-discovers**. Bailing would PREVENT that re-discovery (a regression on
  endpoints the ladder currently recovers). Must witness the ladder cases first.
- **strip unfilled QUERY holes only** — safe for the leak's common case, BUT `shouldReplayRecipe`
  (`:3709`) reads leftover `{placeholders}` as its skip signal; stripping blinds it → a recipe
  could replay when it should not. Must strip on the DIRECT-fetch url only, never the recipe url.
- **the 5 decomposers** (form/xml/graphql/grpc/jsonrpc) each build their own URL/body — a guard
  must cover all five, not just the path-template case.
Next loop: a witness corpus over {path-hole, query-hole, recipe-skip, probe-ladder, each
decomposer}, then the guard, red→green per case. Start from this map.
| 3 | `resolveCached` (local↔remote tier selector) | `src/values/resolution-tier.ts:42` | **0** (test-only) | **dormant-because**: it routes a resolution local-then-remote, but there is no remote resolution-cache backend in the resolve path yet (the "maintenance network" tier). The LOCAL tier is exactly the `cachedResolution` I wired in #1; promoting the prereq cascade to route THROUGH `resolveCached` is the wiring once a remote ledger tier ships. Not pruned — it is the seam for #1's remote half. |
| 4 | `descentResolve` (trust/descent fallback) | `src/trust/descent-cache.ts:99` | **0** (test-only) | **dormant-because**: Paper-2 descent (wallets-own-wallets / hierarchical trust) is not yet on the resolve fallback ladder. A research arm with its own witness; wire only when the descent path is the chosen fallback. Named, not silent. |
| 5 | `agenticBrowserResolve` (agentic browser fallback) | `src/orchestrator/browser-agent.ts:163` | **0** (headless resolve path) | **dormant-because**: reachable only via the MCP browse tools (interactive session), not the headless `unbrowse resolve` ladder. Intentional separation (the headless path must stay deterministic/cheap). Candidate to wire as the LAST-resort resolve fallback behind an explicit flag; until then, dormant-by-design. |
| 6 | `buildCompositeEdges` (walked-chain → composite edges) | `src/orchestrator/index.ts:3938` | **1** (emitted in trace) | **WIRED-partial** — the edges are BUILT and emitted in the route trace, but not PERSISTED as a replayable composite (contract-ledger lever 3). Follow-up: persist + replay the composite as one unit. Not buried (it runs); the persistence half is the open lever. |

## Audit corrections (false-buried, verified WIRED — kept honest)
- `searchIntentResolve` — claimed test-only; **wired** at `orchestrator/index.ts:5066`.
- `runResolveRace` — claimed test-only; **wired** at `orchestrator/index.ts:4412`.
- `probe.unwired` (`cli.ts:5424`) — not a buried export; an ACTIVE flag from
  `ensureKuriProxyReachable()` gating proxy-resilience fallback. Correctly wired.

## Summary
- **1 wired this loop** (#1, the persistent cascade — the loop's GOAL face 1).
- **1 real bug queued** (#2, the `{param}` leak — the next node).
- **3 genuinely dormant, each named with why** (#3 remote tier, #4 descent, #5 agentic) —
  none left silent (GOAL face 2 / ACC#4).
- **1 wired-partial** (#6 composite persistence — an open lever, already tracked).
- **3 audit false-positives corrected** — the verify-before-dispose discipline (Prov 18:17).
