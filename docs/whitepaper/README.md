# Internal APIs Are All You Need

Companion documentation for the Unbrowse whitepaper.

**Paper:** "Internal APIs Are All You Need: Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures"
**Authors:** Lewis Tham (Unbrowse AI), Nicholas Mac Gregor Garcia (NUS), Jungpil Hahn (NUS)
**Year:** 2026

These docs explain the paper's concepts in accessible language and map each claim to the current product. They separate what ships today from what's still on the roadmap.

## Start Here

| Doc | For | Summary |
|-----|-----|---------|
| [The Problem](start-here/the-problem.md) | Everyone | Why browser-first agent architectures fail |
| [What Is Unbrowse?](start-here/what-is-unbrowse.md) | Everyone | Shadow APIs, shared discovery, three-path execution |
| [How It Works](start-here/how-it-works.md) | Everyone | End-to-end walkthrough with a real example |
| [Mental Models](start-here/mental-models.md) | Everyone | DNS for APIs, package manager, mining the web |
| [Plain English](start-here/plain-english.md) | Non-technical | Shortest possible explanation |

## By Audience

| Doc | For | Summary |
|-----|-----|---------|
| [For Investors](by-audience/for-investors.md) | Investors | Market thesis, compounding loop, shipped vs roadmap |
| [For Technical Readers](by-audience/for-technical-readers.md) | Engineers | Architecture, execution paths, eval methodology |

## Reference

| Doc | For | Summary |
|-----|-----|---------|
| [Key Concepts](reference/key-concepts.md) | All | Definitions: shadow API, skill, endpoint, operation graph, scoring |
| [System Today](reference/system-today.md) | Technical | What's shipped: pipeline, auth, CLI, marketplace, passive indexing |
| [Paper vs Product](reference/paper-vs-product.md) | Due diligence | Honest audit: shipped / partial / not yet |
| [Evaluation](reference/evaluation.md) | Technical | 94-domain benchmark, speedup results, cost analysis |
| [Coming Soon](reference/coming-soon.md) | Forward-looking | x402 payments, delta attribution, TEE, dynamic pricing |

## Technical Reference

For implementation details, see:
- [Architecture Guide](../architecture.md) — full pipeline, resolve decision tree, scoring formula
- [API Reference](../api-reference.md) — all REST endpoints with request/response examples
- [Types Reference](../types.md) — SkillManifest, EndpointDescriptor, OperationGraph, ExecutionTrace

## Citation

```bibtex
@misc{tham2026internal,
  title = {Internal APIs Are All You Need: Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures},
  author = {Lewis Tham and Nicholas Mac Gregor Garcia and Jungpil Hahn},
  year = {2026},
  note = {Unbrowse AI}
}
```
