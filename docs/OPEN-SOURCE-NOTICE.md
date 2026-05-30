# Open Source Notice

**Unbrowse is open source (open core).** The SDKs, the agent-interop layer, the payment protocol, and the docs are MIT and public — that is the surface you build on, and it is current, not a frozen snapshot.

A small core stays private, for security rather than instinct. The local capture, indexing, and replay primitives carry real abuse potential if shipped without guardrails:

- **Local session import** can be retargeted at accounts the operator does not own.
- **Route inference + replay** can be aimed at services that explicitly disallow automated access.
- **Marketplace publish + payout** plumbing is a financial path that can be steered into theft if the integrity of the indexer is compromised.
- **Platform-integrity research** contains low-level detail we will not publish until it can be disclosed safely.

Everything outside that core is open. The split:

| Surface | Where it lives | License |
|---|---|---|
| `@unbrowse/client` (HTTP-first SDK) | npm `@unbrowse/client` + `packages/sdk-v2/` | MIT |
| `@unbrowse/sdk` (legacy local-runtime SDK) | npm `@unbrowse/sdk` + `packages/sdk/` | MIT |
| Agent-interop layer (Skills / MCP / OpenAPI / llms.txt / A2A / x402 drop-in) | `src/interop/` | MIT |
| Public repo + docs + whitepaper | [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) | MIT |
| `unbrowse` CLI binary | npm `unbrowse` | proprietary, distributed binary |
| Capture / indexing / runtime engine | private repo | proprietary |
| Backend (marketplace, payouts) | private repo, Cloudflare Workers | proprietary |

## What this means for you

- **Building on the SDK?** New code should use `@unbrowse/client`. Existing local-runtime integrations can keep using `@unbrowse/sdk` plus a running `unbrowse` runtime (`npx unbrowse setup`). Both SDKs are MIT.
- **Reading the repo for architecture?** The public repo, `docs/`, and the [whitepaper](./whitepaper/) reflect current behavior. The SDKs and the interop layer are the real, maintained source.
- **Filing a bug?** Use [github.com/unbrowse-ai/unbrowse/issues](https://github.com/unbrowse-ai/unbrowse/issues) for SDK/CLI issues. The CLI binary tracks current production.
- **Want source access to the private core for security review?** Email security@unbrowse.ai. Review under NDA is available for serious enterprise integrators.

## Why open core, not fully open

We shipped fully open early on, and two patterns showed why the *engine* specifically needs guardrails:

1. **Forks-as-scrapers.** Some forks rebranded the indexer and stripped the marketplace-publish, paid-route, and terms gates — turning a discovery tool into an unattributed scraping fleet.
2. **Platform-integrity escalation.** Publishing low-level evasion detail starts a race that harms legitimate users and site owners.

So the answer is open core, not all-or-nothing: the surface agents build on is open and credited; the abuse-prone engine stays behind a guardrail. Giving agents real APIs was always the point — open core keeps that promise sustainable.

## Open standards we build on — and credit

We fault forks for *unattributed* rebranding; we will not do the same to the layers
below us. Unbrowse's agent-interop surface (`src/interop/`) is a **drop-in for, and
builds on, open standards authored by others**. We interoperate with them and credit
them; we do not fork-and-rebrand them:

| Standard | Author / owner | What we do with it |
|---|---|---|
| **Agent Skills** (`SKILL.md` format) | Anthropic — released as an open standard (agentskills.io) | ingest + serve our routes as skills, to the published spec |
| **Model Context Protocol (MCP)** | Anthropic — open spec (modelcontextprotocol.io) | expose our surface as MCP tools; map every tool to our unified route shape |
| **x402** + **x402 Bazaar** | Coinbase — open payment protocol + public discovery catalog | settle usage over x402; rank a site's already-listed Bazaar resources above any re-wrap |

A unified route is a drop-in *replacement* only in the sense of *interoperating with*
these formats — never of replacing their authorship. Where we build on a cited source,
we keep its `source_id` in the code and build **on top** of it, not over it.

## What's open today

Freely available today, MIT: the `@unbrowse/client` + `@unbrowse/sdk` SDKs and the
agent-interop layer above — so any agent can use Unbrowse through the formats it
already speaks, at no cost and with no lock-in (the browser fallback is always the
exit). USDC settles usage; that's the whole deal — use what's here, build on it, pay
only for what you call.
