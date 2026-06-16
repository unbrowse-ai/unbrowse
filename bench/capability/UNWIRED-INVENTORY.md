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
| 2 | unfilled-`{param}` leak (no pre-fetch hole guard, direct path) | guard now at `src/execution/index.ts` `executeEndpoint` (before recipe-replay + probe ladder) | n/a (a hole, not an export) | **FIXED** — a pre-fetch guard bails with `success:false error:"unfilled_url_hole"` when `url` still matches `/\{[a-z0-9_]+\}/gi` after interpolation, before any network. Witness `test_param_leak_guard.ts` (behavioral via real `executeSkill` + structural), mutation-proven: with the guard neutered the holed url is genuinely SENT (test fails "Unable to connect") — proving both the leak and the fix. tsc delta 0. |

### Item #2 hazard map — PROBED & CORRECTED (Mark 9:24; seed = `test_param_leak_characterization.ts`)
Two probers settled the unknowns with code evidence; the seed pins them runnably. The map's
first draft over-feared — one asserted hazard was an apophenia and is now retracted:
- **`shouldReplayRecipe` (`:5575`)** = `return !/\{[a-z0-9_]+\}/i.test(substitutedUrl)` — CONFIRMED
  skips replay on a leftover `{hole}` → control flows to the probe ladder (`:3791`).
- **The probe ladder (`:3791`)** calls `probeUrl(url, …)` with the HOLED url verbatim — there is
  **no `stripHoles`/rewrite** of `url` before it. ⇒ it cannot recover a hole; it just probes a
  malformed url and fails. **RETRACTED hazard:** "bail-early collides with probe-ladder
  re-discovery" was an unwitnessed feeling — bailing on a holed url loses no recovery.
- **The 5 decomposers (form/xml/graphql/grpc/jsonrpc) all build BODIES, not URLs** — so a URL-hole
  guard covers ONLY the plain url-template path (much smaller than first feared). Body-hole leakage
  is a separate, lower-risk question.
- **Resolution runs BEFORE execute** (`walkPrerequisiteChain`+`inferParamsFromIntent` → then
  `executeSkill`), so a hole reaching `:3311` is a genuine miss, not a not-yet-resolved value.
- **Bail vessel** (mirror): the session-bound gate (`:2834`) `stampTrace({success:false,
  error:"…"}); return {trace, result}` BEFORE any fetch.
**Revised guard (much simpler):** a pre-`probeUrl` bail on the direct path — if `url` still matches
`/\{[a-z0-9_]+\}/i`, return `success:false error:"unfilled_url_hole"` instead of probing a malformed
url. Does NOT touch `interpolate`/`shouldReplayRecipe` (recipe path unaffected).
**The ONE remaining unknown** (named, not assumed): whether any probe-ladder rung DROPS the holed
segment and recovers — the probers found none, but did not exhaustively trace every rung. The
guard's own loop settles this with a probe-ladder integration witness, then ships the bail red→green.
| 3 | `resolveCached` (local↔remote tier selector) | DELETED (was `src/values/resolution-tier.ts`) | n/a | **DELETED** — de-hatching: 0 prod imports, 0 sibling usage; a speculative remote-tier selector with no remote backend. No dormant-by-design. Removed the file + test (also cleared 15 pre-existing tsc errors). |
| 4 | `descentResolve` (trust/descent fallback) | DELETED (was `src/trust/descent-cache.ts`) | n/a | **DELETED** — de-hatching: 0 prod imports/callers; a Paper-2 research arm never wired. Removed the file + test. |
| 5 | `agenticBrowserResolve` (agentic browser fallback) | DELETED (was `src/orchestrator/browser-agent.ts`) | n/a | **DELETED** — de-hatching: 0 prod imports/callers; never wired into any resolve path. Removed the file. |
| 6 | `buildCompositeEdges` (walked-chain → composite edges) | `src/orchestrator/index.ts:3938` | **1** (emitted in trace) | **WIRED-partial** — the edges are BUILT and emitted in the route trace, but not PERSISTED as a replayable composite (contract-ledger lever 3). Follow-up: persist + replay the composite as one unit. Not buried (it runs); the persistence half is the open lever. |

## Audit corrections (false-buried, verified WIRED — kept honest)
- `searchIntentResolve` — claimed test-only; **wired** at `orchestrator/index.ts:5066`.
- `runResolveRace` — claimed test-only; **wired** at `orchestrator/index.ts:4412`.
- `probe.unwired` (`cli.ts:5424`) — not a buried export; an ACTIVE flag from
  `ensureKuriProxyReachable()` gating proxy-resilience fallback. Correctly wired.

## ACC#2 — CLI persistence/replay e2e (Day 6) + Day-8 cold-audit correction
Driven via `bun src/cli.ts resolve --intent … --url https://httpbin.org/json --json` (live source):
- **Run 1:** `cache_hit:false`, resolution ledger 218→219 (persisted), real httpbin JSON.
- **Run 2:** `cache_hit:true`, ledger unchanged (replayed), identical `trace_id` (cached serve).

**CORRECTION (Day-8 cold audit, Auditor 7):** the headline previously over-claimed. The run used a
single-step `direct-fetch` (zero prerequisites), so `walkPrerequisiteChain` — and therefore the
per-prereq `cachedResolution` wired THIS loop (01db12a6) — was **never invoked**. The e2e exercised
the **pre-existing** cli.ts resolution cache (`peekResolution`/`storeResolution`, cli.ts:996/1280),
not the loop's wiring. So ACC#2 is honestly: the CLI→orchestrator→resolution-persistence seam runs
end-to-end on the real binary, but the **multi-step prereq cascade specifically** remains witnessed
at unit + structural level only (`test_persistent_cascade_walk.ts`); its full-network e2e needs a
multi-step skill fixture and is NOT yet behaviorally proven. Named, not faked.

## Summary
- **1 wired this loop** (#1, the persistent cascade — the loop's GOAL face 1).
- **1 real bug FIXED** (#2, the `{param}` leak — pre-fetch guard, mutation-proven).
- **3 dormant stubs DELETED** (#3 resolveCached, #4 descentResolve, #5 agenticBrowserResolve) — de-hatching: 0 prod usage, removed (also cleared 15 tsc errors).
- **1 wired-partial** (#6 composite persistence — an open lever, already tracked).
- **3 audit false-positives corrected** — the verify-before-dispose discipline (Prov 18:17).
