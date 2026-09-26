# Internal APIs Are All You Need

Companion docs for the Unbrowse whitepaper.

- Authors: Lewis Tham, Nicholas Mac Gregor Garcia, Jungpil Hahn
- arXiv: 2604.00694
- Canonical PDF: <a href="./unbrowse-whitepaper.pdf" target="_blank" rel="noopener noreferrer">unbrowse-whitepaper.pdf</a>
- Paper draft synced here: April 1, 2026

> Important
> The PDF mixes research results, product behavior and forward-looking economic design.
> These docs separate the three: what the paper measured, what the hosted Unbrowse service does today, and what is still roadmap.

## The short version

Most of the web's value sits behind interfaces built for humans. Websites already call their own internal APIs.

Unbrowse learns those requests once, in a cloud browser, and compiles them into capabilities agents call over HTTP. Later agents skip the browser.

## What ships today

Unbrowse is a hosted service (`https://v3.unbrowse.ai`, closed source) with an open-source client (this repo).

The service:

- records tasks in a cloud browser (patchright) and fulfils the first request while learning it
- compiles recorded sessions or HAR files into `learned.*` capabilities (harness YAML, `unbrowse/v1alpha1`)
- replays them over first-party HTTP, with a render fallback for reads HTTP cannot finish
- verifies outcomes: HTTP 200 is not success
- keeps a public registry of scrubbed, re-verified read-only site tools, each site also an MCP server and an OpenAPI document
- keeps logins in a password manager the model never reads, signs in on replay and reuses sessions
- bills only verified calls: 500 a month free, then $10 per 10,000; x402 pay-per-call without an account
- routes plain-language tasks with Jev, with a deterministic fallback

The client is `@unbrowse/sdk` and a thin CLI over the service's REST API (`/api/v1`); agents use the remote MCP (`/mcp`).

Not built: per-route pricing, contributor payouts, validator markets, attestation.

## Pages

- [Unbrowse In Plain English](./plain-english.md)
- [What Is Unbrowse?](./what-is-unbrowse.md)
- [The Problem](./the-problem.md)
- [Mental Models](./mental-models.md)
- [How It Works](./how-it-works.md)
- [For Technical Readers](./for-technical-readers.md)
- [For Investors](./for-investors.md)
- [Public Registry and Maintenance](./network-layer.md)
- [Credential Sovereignty](./credential-sovereignty.md)
- [Key Concepts](./key-concepts.md)
- [System Today](./system-today.md)
- [Paper vs Product Status](./paper-vs-product.md)
- [Evaluation and Benchmarks](./evaluation.md)
- [Coming Soon](./coming-soon.md)

## Where to start

- Shortest explainer: [Plain English](./plain-english.md).
- Architecture and evidence: [For Technical Readers](./for-technical-readers.md).
- Market and business: [For Investors](./for-investors.md).
- Current state, piece by piece: [System Today](./system-today.md).
- Strict audit of the paper: [Paper vs Product Status](./paper-vs-product.md).
- Numbers and where they come from: [Evaluation and Benchmarks](./evaluation.md).

## Citation

```bibtex
@misc{tham2026internal,
  title = {Internal APIs Are All You Need},
  author = {Lewis Tham and Nicholas Mac Gregor Garcia and Jungpil Hahn},
  year = {2026},
  eprint = {2604.00694},
  archivePrefix = {arXiv},
  note = {Official Unbrowse whitepaper}
}
```
