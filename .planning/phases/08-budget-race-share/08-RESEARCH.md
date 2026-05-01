---
phase: 08
title: Latency Budget + Parallel Race + Share Pointers
goal: Per-call latency budget, parallel race of recipe || marketplace || probe, explicit `unbrowse capture` verb, opt-in marketplace contribution
---

# Phase 08 Research

## Why this phase exists

Phase 7 made the executor honest about WHAT it's doing (probe + recipe + decision_trace). It did NOT make resolve fast or honest about HOW LONG it will take. Three issues remain after v6.3.0:

1. **Latency is unpredictable.** Resolve serially tries route cache → marketplace → first-pass browser (8s) → browse-session-handoff. An agent on a tight deadline cannot tell whether a call will return in 80ms or 8s.
2. **Browser-capture is silent fallback.** Resolve opens a Kuri tab on cache miss without the agent asking for it. Costs 8s at minimum, sometimes minutes if the page is slow. Surprises the agent's planner.
3. **Marketplace publish is opt-out, not opt-in.** Every captured route gets queued for marketplace publish unless the user knows to disable it. Privacy-by-default requires the inverse.

All three are runtime contract issues — same code paths, wrong defaults / wrong sequencing.

## First-principles analysis

### What an agent actually wants

An agent making a web call optimizes for three things:

1. **Latency** — wall-clock time to bytes
2. **Predictability** — will this be 200ms or 30s? I need to plan
3. **Honesty** — when you don't have it, tell me clearly, don't pretend

"Fast mode" is therefore not a global config setting — it's a **per-call latency budget** that the pipeline must respect. Different calls from the same agent want different budgets:

- 200ms — UI loop, user is waiting
- 2s — background enrichment
- 30s — best-effort, agent has nothing else to do

### Race the lookups, don't serialise them

Today's resolve is serial. The fast path takes the slowest of (recipe replay) + (marketplace fetch) + (probe). For an agent on a 200ms budget that's ~600ms typical.

The right shape is **`Promise.race`-with-deadline**:

```
t=0:    fire 3 lookups in parallel
        - recipe replay        (typical 80–300ms)
        - marketplace lookup   (typical 50–200ms, local-cached after first hit)
        - HEAD probe of URL    (typical 100–400ms)
t=N:    first valid response wins
        if deadline hits: return no_match with tried[...]
```

Marketplace lookup gets a 5-min local TTL so repeat resolves on the same domain don't round-trip. Probe is the same primitive Phase 7 already built.

### Capture is a separate verb, not a fallback

Today resolve quietly opens a Kuri tab when nothing matches. The agent didn't ask. It pays 8s+ for a discovery it didn't budget for.

Better: `unbrowse capture --url ... --intent ...` is its own command. Resolve on miss returns:

```json
{
  "status": "no_match",
  "tried": ["recipe", "marketplace", "probe"],
  "next_step": {
    "command": "unbrowse capture --url ... --intent ...",
    "est_ms": 8000,
    "creates_skill": true
  }
}
```

Now the agent sees the cost and decides. Discoverability is the same (next_step is right there) but consent is explicit.

### Privacy-by-default

Every captured route today flows through `cachePublishedSkill` → `queueBackgroundIndex` → marketplace publish. The user's browsing patterns become public unless they know to disable. EU/GDPR-shaped users can't trust the install.

One config field flips this: `share_pointers: false` by default. When false, `cachePublishedSkill` skips `queueBackgroundIndex` entirely. Local cache + replay still work — there's no privacy cost to local recipes — but nothing leaves the machine.

Setup prompts once with three tiers:

```
1. Private (default): cache locally, never publish
2. Share pointers: contribute to the marketplace, no rev-share
3. Share + earn: contribute and add a wallet for x402 micropayments
```

Existing users on upgrade silently land on `private` with a one-time stderr notice for 5 invocations explaining the change and how to opt back in.

### Why deletion happens here, not later

The Phase 7 `@deprecated` comments on `deriveStructuredDataReplay` (per-host registry) and the now-unused `endpoint.exec_strategy` field have been load-bearing for one release cycle. With Phase 7 shipped + verified, no consumers depend on them. Phase 8 deletes them as part of the same migration window so we don't carry dead code into Phase 9.

## Existing pipeline → new pipeline

| Old (v6.3.0) | New (Phase 8) |
|---|---|
| resolve → route_cache → marketplace → first_pass_browser → handoff | resolve → race(recipe \|\| marketplace_local \|\| probe) → no_match-with-next_step |
| 8s default budget, no agent control | per-call `--budget` flag, default 8000ms preserved |
| Marketplace lookup hits backend every time | 5-min in-process TTL cache (skill_id → manifest) |
| Browser capture inside resolve | `unbrowse capture` standalone verb |
| `cachePublishedSkill` always queues for publish | gated on `config.share_pointers` |
| Setup auto-completes with publish enabled | Setup prompts once, default no |
| Per-host `deriveStructuredDataReplay` 6-arm switch | DELETED — Phase 7 recipe replay subsumes it |
| `endpoint.exec_strategy` cached field | DELETED — Phase 7 probe ladder subsumes it |

## Open questions

- **Marketplace TTL invalidation.** 5-minute TTL is fine for stability. When a user explicitly publishes (contributor mode), should we bust the TTL for that domain so other agents see the new skill within the publish window? Yes — `publishSkill` calls `marketplaceCache.invalidate(domain)`.
- **Budget aborts vs deadline race.** AbortController on every in-flight request when budget hits is the clean model. Some HTTP clients ignore aborts mid-flight; ensure all use `fetch(url, {signal})`. The probe primitive from Phase 7 already does.
- **Capture verb output shape.** Should `unbrowse capture` return the same `decision_trace` envelope as execute, or a capture-specific shape (endpoints discovered, skill_id created, marketplace published Y/N)? I lean capture-specific because the question is different: not "what was the result of running this endpoint" but "what skill did we just learn".
- **Existing-user notice frequency.** 5 invocations of the stderr notice is a guess. Track via `~/.unbrowse/config.json: notice_shown_count` and decrement on each show.

## Out of scope

- LLM-judged budget selection (agent picks budget per call manually for now).
- Multi-region marketplace lookup (single backend for now).
- Streaming partial results during the race (return-when-first-wins is enough).
- Setup UI beyond the existing `unbrowse setup` CLI prompt (no web UI).
- Recipe-drift LLM judge (Phase 9 if needed).
