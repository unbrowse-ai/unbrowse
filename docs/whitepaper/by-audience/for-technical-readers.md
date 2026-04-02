# For Technical Readers

This page is the fastest way to understand the Unbrowse product that exists in the repo today.

It is intentionally stricter than the whitepaper.

## The Technical Thesis

Unbrowse is a local-first web capability layer for agents.

It does two things:

1. learn structured website routes from real browser traffic
2. reuse those routes later through ranking, verification, and fallback logic

The important product move is not just capture.

It is resolve plus reuse.

## Current System Shape

The codebase currently ships:

* CLI entrypoint
* local HTTP server
* Kuri-backed browser capture runtime
* shared marketplace for discovered skills
* MCP server mode for agent hosts
* local credential vault with encrypted fallback

That means the system already supports both first-run learning and later-run reuse.

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

* direct replay
* browser-context execution
* DOM extraction fallback

That distinction matters because "network-level execution" is directionally right, but browser-bound state is still necessary on stricter sites.

## What Is Real Product Truth

When describing current quality, anchor on the canonical eval stack in this repo:

* `bun run eval:core`
* `bun run eval:full`

Those gates judge more than final answer quality.

They can cover:

* retrieval correctness
* route selection correctness
* execution correctness
* multistep workflow behavior

For current product claims, these evals matter more than historical benchmark numbers in the paper.

## What Is Shipped Versus Forward-Looking

Shipped today:

* local cache plus marketplace plus live-capture fallback
* passive discovery from real usage
* reliability-aware ranking
* verification-aware ranking
* schema drift handling
* skill lifecycle states
* local-first auth handling

Partial today:

* graph-backed planning surfaces
* pre-publish quality gating beyond the practical current loop
* richer trust scoring ideas described in the paper

Coming soon:

* route pricing
* contributor payouts
* validator market
* staking and slashing
* signed attestations
* TEE or E2B-backed proof layers

If a claim depends on a route economy, read it as roadmap, not current product behavior.

## Recommended Reading Order

Read these pages in order:

1. [What Is Unbrowse?](../start-here/what-is-unbrowse.md)
2. [How It Works](../start-here/how-it-works.md)
3. [System Today](../reference/system-today.md)
4. [Paper vs Product Status](../reference/paper-vs-product.md)
5. [Evaluation and Benchmarks](../reference/evaluation.md)

## The Short Version

The repo already proves the core capability-layer thesis:

* agents can learn useful web routes from real use
* those routes can be reused later
* ranking and verification can keep good routes hot
* browser parity can be preserved when needed

The repo does not yet prove the full economic and trust architecture described in the paper.

That separation is the key to reading the system accurately.
