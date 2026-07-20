# Internal APIs Are All You Need

Implementation-aware companion notes for the Unbrowse research paper.

- Authors: Lewis Tham, Nicholas Mac Gregor Garcia, Jungpil Hahn
- Status: research paper with current-product companion notes
- Product version documented here: Unbrowse 11.1.1

> The paper captures the research thesis and some forward-looking economic ideas. The current product uses account credits. Credits are granted, earned, and consumed in the Unbrowse ledger; redemption will be introduced later. Research-era settlement designs are not part of the current SDK or product contract.

## The Short Hook

The web contains a huge amount of usable value behind interfaces designed for humans. Unbrowse learns the request paths underneath those interfaces, turns successful routes into reusable skills, and lets later agents reuse them without rediscovering the same workflow.

## Read the Current Product First

- [Unbrowse in Plain English](./plain-english.md)
- [For Technical Readers](./for-technical-readers.md)
- [System Today](./system-today.md)
- [Paper vs Product Status](./paper-vs-product.md)
- [Evaluation and Benchmarks](./evaluation.md)

## What Ships Today

- the `unbrowse` 11.1.1 CLI and local server
- HTTP-first route resolution with browser capture fallback
- reusable learned skills and marketplace-backed discovery
- local credential storage and authenticated replay
- MCP and SDK integrations
- reliability scoring, verification, and drift handling
- account API keys and a credit ledger for metered usage

## Research Boundary

The paper remains useful for its shared-route graph, reuse, evaluation, and maintenance thesis. Any economic mechanism described in the original research artifact should be read as historical or forward-looking research, not as the current product API.

## Citation

```bibtex
@misc{tham2026internal,
  title = {Internal APIs Are All You Need},
  author = {Lewis Tham and Nicholas Mac Gregor Garcia and Jungpil Hahn},
  year = {2026},
  note = {Unbrowse research paper}
}
```
