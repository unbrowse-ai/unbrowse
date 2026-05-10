# Open Source Notice

**The public open-source Unbrowse repo at [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) is an outdated snapshot.** It does not reflect what current production builds do.

Later versions are **closed-source** because the capture, reverse-engineering, and replay primitives that make Unbrowse work also create real abuse risk if shipped without guardrails:

- **Cookie / session import** can be retargeted at credentials the operator does not own.
- **Endpoint inference + replay** can reconstruct internal APIs of services that explicitly disallow it.
- **Marketplace publish + payout** plumbing is a financial path that can be steered into theft if the integrity of the indexer is compromised.
- **Anti-bot bypass research** in newer branches contains active vendor-specific research that we will not publish.

The split:

| Surface | Where it lives | License |
|---|---|---|
| Public OSS snapshot (older) | [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) | MIT, frozen |
| `@unbrowse/sdk` (thin client) | npm `@unbrowse/sdk` + `packages/sdk/` | MIT |
| `unbrowse` CLI binary | npm `unbrowse` | proprietary, distributed binary |
| Capture / RE / runtime engine | private repo | proprietary |
| Backend (marketplace, payouts) | private repo, Cloudflare Workers | proprietary |

## What this means for you

- **Building on the SDK?** You only need `@unbrowse/sdk` plus a running `unbrowse` runtime (`npx unbrowse setup`). The SDK is MIT and stable.
- **Reading the OSS repo for architecture?** Treat it as a 2025 historical reference. Look here in `docs/` and at the public [whitepaper](./whitepaper/) for current behavior.
- **Filing a bug?** Use [github.com/unbrowse-ai/unbrowse/issues](https://github.com/unbrowse-ai/unbrowse/issues) for SDK/CLI issues. The CLI binary tracks current production.
- **Want source access for security review?** Email security@unbrowse.ai. Code review under NDA is available for serious enterprise integrators.

## Why we made this call

We shipped fully open until April 2026. Two patterns forced the change:

1. **Forks-as-scrapers.** Several forks rebranded the indexer and removed marketplace-publish, paid-routes, and ToS gates — turning a benign discovery tool into an unattributed scraping fleet.
2. **Anti-bot vendor escalation.** When we publish a new bypass technique, vendors patch it within days. Public commits make this an unwinnable race for our paying users.

We still believe in giving agents real APIs. Closing the source is a tradeoff we made to keep that promise sustainable, not a permanent posture.
