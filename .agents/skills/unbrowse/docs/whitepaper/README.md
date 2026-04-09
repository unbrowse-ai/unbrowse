# Internal APIs Are All You Need

Implementation-aware companion docs for the Unbrowse whitepaper.

- Authors: Lewis Tham, Nicholas Mac Gregor Garcia, Jungpil Hahn
- Canonical PDF: <a href="./unbrowse-whitepaper.pdf" target="_blank" rel="noopener noreferrer">unbrowse-whitepaper.pdf</a>
- Status: official paper plus implementation-aware companion docs
- Canonical paper draft synced here: April 1, 2026

> Important
> The PDF mixes shipped product behavior, research results, and forward-looking economic design.
> These companion docs separate those three things so readers can tell what exists in the codebase today, what already ships in the current x402/payment lane, and what is still coming soon.

## What This Companion Covers

- What Unbrowse ships today
- Which whitepaper claims map directly to the codebase
- Which paper sections are partial implementations
- Which paper sections are still `coming soon` beyond the shipped payment lane
- Which evaluation paths are current product truth versus paper benchmark context

## The Short Hook

The web contains a huge amount of usable value, but most of it is trapped behind interfaces built for humans.

Unbrowse is a way to unlock that layer for agents.

It learns the request paths underneath websites, turns successful routes into reusable skills, and makes later agents faster and less brittle because they do not have to rediscover the same workflows from scratch.

## Quick Navigation

- [Unbrowse In Plain English](./plain-english.md)
- [For Technical Readers](./for-technical-readers.md)
- [For Investors](./for-investors.md)
- [Marketplace and Maintenance](./network-layer.md)
- [What Is Unbrowse?](./what-is-unbrowse.md)
- [The Problem](./the-problem.md)
- [Mental Models](./mental-models.md)
- [How It Works](./how-it-works.md)
- [Key Concepts](./key-concepts.md)
- [System Today](./system-today.md)
- [Paper vs Product Status](./paper-vs-product.md)
- [Evaluation and Benchmarks](./evaluation.md)
- [Coming Soon](./coming-soon.md)

## Recommended Reading Order

Start with [For Investors](./for-investors.md) or [For Technical Readers](./for-technical-readers.md) for the public/product truth.

Read [Marketplace and Maintenance](./network-layer.md) for the public explanation of how shared route reuse creates freshness, validation, attribution, and maintenance requirements over time.

## What Ships Today

Unbrowse today is a local-first web capability layer for agents:

- local CLI plus local server
- browser capture through Kuri
- reverse-engineering of internal API endpoints from observed traffic
- marketplace-backed reuse of discovered skills
- route cache plus marketplace search plus live-capture fallback
- local credential storage and auth reuse
- MCP server mode plus host integrations for major agent environments
- reliability scoring, verification, and schema-drift-aware endpoint health
- x402-gated marketplace search/execution paths, HTTP 402 payment requirements, wallet-linked payment metadata, and current payout routing
- canonical product evals in this repo

## What To Read First

Read [Unbrowse In Plain English](./plain-english.md) if you want the shortest narrative explainer in normal language.

Read [For Technical Readers](./for-technical-readers.md) if you want the current architecture, eval truth, and paper-vs-product boundary in one place.

Read [For Investors](./for-investors.md) if you want the market framing, compounding product loop, and the clean line between shipped product and roadmap.

Read [System Today](./system-today.md) if you want the current product.

Read [What Is Unbrowse?](./what-is-unbrowse.md) and [How It Works](./how-it-works.md) if you want the narrative explainer layer that used to live in the old docs set, now rewritten against the current repo and whitepaper.

Read [Paper vs Product Status](./paper-vs-product.md) if you want the strict audit: shipped, partial, or `coming soon`.

Read [Coming Soon](./coming-soon.md) if you care about the parts of the route economy that are still forward-looking: richer multi-party fee splits, fuller attribution, validator attestation, and the rest of the paper beyond the shipped payment lane.

## Citation

```bibtex
@misc{tham2026internal,
  title = {Internal APIs Are All You Need},
  author = {Lewis Tham and Nicholas Mac Gregor Garcia and Jungpil Hahn},
  year = {2026},
  note = {Official Unbrowse whitepaper with implementation-aware companion docs}
}
```
