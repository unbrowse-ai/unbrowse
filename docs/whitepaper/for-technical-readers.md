# For Technical Readers

This page is the fastest way to understand the Unbrowse product that exists in the repo today.

It is intentionally stricter than the whitepaper.

## Positioning Snapshot

Unbrowse is not best understood as a generic browser wrapper.

It is a reusable execution layer that learns routes from real browser traffic, then reuses those routes with ranking, verification, and fallback logic.

The clean category shorthand is:

Unbrowse is a drop-in replacement for OpenClaw / `agent-browser` browser flows for agents.

That does not mean "the browser disappears everywhere." It means agent workflows can keep a browser-shaped interface while Unbrowse swaps repeated UI replay for route resolution and execution whenever it can.

The practical performance pitch is:

- on the API-native path, roughly ~30x faster
- roughly ~90% cheaper than repeated browser execution
- reusable route assets instead of one-off browser work

The closest alternatives are:

- Playwright / Puppeteer-style browser automation
- custom one-off API reverse engineering
- teams building and maintaining their own private route cache

The useful category label is "execution infrastructure for agent access to the web."

## The Technical Thesis

Unbrowse is a local-first web capability layer for agents.

It does two things:

1. learn structured website routes from real browser traffic
2. reuse those routes later through ranking, verification, and fallback logic

The important product move is not just capture.

It is resolve plus reuse.

## Current System Shape

The codebase currently ships:

- CLI entrypoint
- local HTTP server
- Kuri-backed browser capture runtime
- shared marketplace for discovered skills
- MCP server mode for agent hosts
- local credential vault with encrypted fallback

That means the system already supports both first-run learning and later-run reuse.

## What A Skill Actually Is

A skill is not just a saved URL.

In practice it is a complete execution plan with:

- route and schema knowledge
- auth assumptions
- refresh or replay behavior
- reliability state
- fallback paths when direct replay is weak

That matters because the moat is not raw endpoint discovery alone. It is maintained execution knowledge.

## The Real Execution Loop

The practical flow today is:

1. resolve intent
2. search local caches and marketplace candidates
3. rank by similarity, reliability, freshness, and verification state
4. execute the best viable route
5. fall back to live capture if reuse is weak
6. feed result quality back into scoring and route health

Execution is not single-path.

Depending on the site and task, Unbrowse can use:

- direct replay
- browser-context execution
- DOM extraction fallback

That distinction matters because "network-level execution" is directionally right, but browser-bound state is still necessary on stricter sites.

## What To Say, What To Avoid

Say:

- drop-in replacement for browser automation in agent stacks
- ~30x faster on the API-native path
- ~90% cheaper than repeated browser execution
- learn once, reuse later
- shared route memory
- maintained execution knowledge
- browser fallback when needed

Avoid:

- "this replaces the browser everywhere today"
- "this is just scraping"
- "this is only a route registry"

## What Is Real Product Truth

When describing current quality, anchor on the canonical eval stack in this repo:

- `bun run eval:core`
- `bun run eval:full`

Those gates judge more than final answer quality.

They can cover:

- retrieval correctness
- route selection correctness
- execution correctness
- multistep workflow behavior

For current product claims, these evals matter more than historical benchmark numbers in the paper.

## What Is Shipped Versus Forward-Looking

Shipped today:

- local cache plus marketplace plus live-capture fallback
- passive discovery from real usage
- reliability-aware ranking
- verification-aware ranking
- schema drift handling
- skill lifecycle states
- local-first auth handling
- x402 / HTTP 402 payment lane with wallet-linked metadata and current payout routing

Partial today:

- graph-backed planning surfaces
- pre-publish quality gating beyond the practical current loop
- richer trust scoring ideas described in the paper

Coming soon:

- the full paper-era route economy beyond the shipped payment lane
- multi-party contributor payouts and delta-style attribution
- validator market
- staking and slashing
- signed attestations
- TEE or E2B-backed proof layers

If a claim depends on the broader paper economy rather than the shipped x402 lane, read it as roadmap, not current product behavior.

## Recommended Reading Order

Read these pages in order:

1. [What Is Unbrowse?](./what-is-unbrowse.md)
2. [How It Works](./how-it-works.md)
3. [System Today](./system-today.md)
4. [Paper vs Product Status](./paper-vs-product.md)
5. [Evaluation and Benchmarks](./evaluation.md)

## The Short Version

The repo already proves the core capability-layer thesis:

- agents can learn useful web routes from real use
- those routes can be reused later
- ranking and verification can keep good routes hot
- browser parity can be preserved when needed

The repo does not yet prove the full economic and trust architecture described in the paper.

That separation is the key to reading the system accurately.
