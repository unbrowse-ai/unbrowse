# Unbrowse retention and reliability evals

This repo already had strong correctness and auth harnesses. This document adds a product-facing eval layer for the questions we keep asking in PMF work:

- Did the product silently break, or did event traffic disappear?
- Are warm / repeated runs actually better than cold runs?
- Would a user come back and trust the same route again tomorrow?
- Are we sticky enough to even talk about becoming a default browser for agentic work?

## Mapping from OpenClaw docs

OpenClaw testing guidance (`docs.openclaw.ai/help/testing` and `docs.openclaw.ai/reference/test`) recommends thinking in three layers:

1. Unit / integration
2. E2E / gateway smoke
3. Live / real-provider checks

For Unbrowse, the equivalent framing is:

1. Unit / integration
   - extraction correctness
   - capture / replay / auth recovery
   - marketplace / graph / cache regressions
2. E2E / workflow smoke
   - CLI and backend flows
   - auth-site and public-route harnesses
3. Live repeatability / stickiness
   - can the same real workflow succeed cold and then warm?
   - does warm reuse reduce latency / token cost?
   - does a route stay usable after the first run?

## Canonical setup

Default public-confidence command:

```bash
npm run eval:core
```

This is the one good product-facing setup. It covers:
- marketplace retrieval correctness
- task-shaped public execution correctness
- WebArena-style multistep retrieval + selection + execution correctness

Fuller command when auth behavior matters:

```bash
npm run eval:full
```

This adds the broader auth corpus on top of `eval:core`.

## Marketplace retrieval accuracy

Marketplace speed is not enough. We also need to know whether marketplace search returns the right skill/endpoint and whether a domain-scoped lookup stays inside the requested domain lane.

Run directly:

```bash
npm run eval:retrieval
```

This suite:
- publishes a small deterministic retrieval fixture set into the marketplace graph
- queries `/v1/search`, `/v1/search/domain`, and `/v1/search/resolve`
- checks expected endpoint rank in the target lane
- checks domain-filter leakage for domain-scoped retrieval
- checks that resolve still uses global fallback when the exact domain lane is sparse

It writes:
- `evals/marketplace-retrieval-last-run.json`

Use it before shipping search / ranking / graph / marketplace-hydration changes.

The retrieval corpus now covers all three retrieval lanes with broader rank and leakage checks:

- global search rank
- domain-scoped rank + exact-domain leakage
- `search/resolve` domain lane rank
- `search/resolve` global fallback rank when the requested lane is sparse

This is meant to catch:

- wrong endpoint at top-1
- sibling-domain bleed
- missing global fallback
- graph/index regressions hidden by a too-small fixture set

## Advanced / supporting suites

These still exist, but they are not the main story anymore:

- `npm run eval:codex`
- `npm run eval:codex:auth`
- `npm run eval:codex:stress`
- `npm run eval:codex:repeatability`
- `npm run eval:codex:many-domains:gate`

Use them for debugging, breadth, or warm-path investigations. Do not use them as the primary product claim by themselves.

## Repeatability suite

The new corpus lives at:
- `evals/codex-cases.repeatability.json`

This corpus is intentionally public and stable. It covers repeated-use developer workflows that should become boringly dependable if Unbrowse is getting sticky:

- package lookups
- docs search
- community scans
- registry / catalog checks
- seeded query reuse

The goal is not just one-shot success. The goal is repeated success with a warm path that is as good or better than a cold path.

### Run the suite directly

```bash
npm run eval:codex:repeatability
```

This runs the autonomous harness in benchmark mode against the repeatability corpus and writes:
- `evals/codex-repeatability-last-run.json`

### Generate a human report

```bash
npm run eval:codex:repeatability:report
```

This will:
1. run the benchmarked repeatability suite
2. parse the output
3. print a compact markdown report with per-case verdicts

### Enforce the warm-path gate

```bash
npm run eval:codex:repeatability:gate
```

This runs the benchmarked repeatability suite and then fails if a supposedly warmed workflow still:

- misses the cache
- resolves through a blocked warm source like `live-capture`
- exceeds its warm latency budget
- regresses too far versus the cold run

## Many-domain public coverage

The broader public many-domain corpus already lives in:
- `evals/codex-cases.public-expansion.json`

What was missing was a first-class gate. Run:

```bash
npm run eval:codex:many-domains:gate
```

This runs the autonomous harness on the public-expansion corpus and then enforces:

- enough total cases
- enough distinct hosts
- enough distinct intent families
- enough satisfied cases
- enough satisfied ratio

It writes:
- `evals/codex-many-domains-last-run.json`

Use this when making claims like "works across many sites" instead of leaning only on a tiny product-success suite.

## How to interpret the report

Each case gets one of these high-level verdicts:

- `repeat-ready` — cold and warm both succeed, with a positive speedup and/or token improvement
- `repeat-pass` — cold and warm both succeed, but there is not much warm-path improvement yet
- `warm-only` — cold fails but warm succeeds; useful for understanding cache-dependent workflows, but not default-browser ready
- `warm-regressed` — cold succeeds but warm fails; this is a serious reliability smell
- `failing` — neither path is dependable enough

## What “sticky enough” means here

For a workflow family to count as sticky, we want:

- repeated success, not just a one-off demo pass
- warm-path latency or token improvement
- no auth / route degradation on the second run
- enough trust that a user would choose Unbrowse again without re-learning the product

In practice, use the repeatability report as the bridge between correctness and retention:

- correctness says the route can work
- repeatability says a user might trust it twice
- retention comes when enough real workflows are `repeat-ready`

## Suggested release gate

Before shipping changes that affect route resolution, capture, replay, or auth reuse:

```bash
npm test
npm run eval:core
```

Add `npm run eval:codex:auth` when touching auth bootstrap / cookie reuse.
Add `npm run eval:retrieval` when touching marketplace search, graph indexing, domain bias, or ranking.
Add `npm run eval:codex:many-domains:gate` when claiming broader public-site coverage.

For a one-command public release check:

```bash
npm run eval:core
```

For the fuller matrix including auth:

```bash
npm run eval:full
```

## Future additions

The next eval gaps to fill are:

- authenticated repeatability cases
- session persistence across restart
- default-browser-ish daily-driver flows
- explicit `endpoint:agents` health evals tied to the highest-value real workflows
- larger marketplace retrieval corpora across more domains and intent families
