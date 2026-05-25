# Open Source Notice

**The public open-source Unbrowse repo at [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) is an outdated snapshot.** It does not reflect what current production builds do.

Later versions are **closed-source** because the local capture, indexing, and replay primitives that make Unbrowse work also create real abuse risk if shipped without guardrails:

- **Local session import** can be retargeted at accounts the operator does not own.
- **Route inference + replay** can be aimed at services that explicitly disallow automated access.
- **Marketplace publish + payout** plumbing is a financial path that can be steered into theft if the integrity of the indexer is compromised.
- **Platform integrity research** contains low-level details that we will not publish until they can be safely disclosed.

The split:

| Surface | Where it lives | License |
|---|---|---|
| Public OSS snapshot (older) | [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) | MIT, frozen |
| `@unbrowse/client` (HTTP-first SDK) | npm `@unbrowse/client` + `packages/sdk-v2/` | MIT |
| `@unbrowse/sdk` (legacy local-runtime SDK) | npm `@unbrowse/sdk` + `packages/sdk/` | MIT |
| `unbrowse` CLI binary | npm `unbrowse` | proprietary, distributed binary |
| Capture / indexing / runtime engine | private repo | proprietary |
| Backend (marketplace, payouts) | private repo, Cloudflare Workers | proprietary |

## What this means for you

- **Building on the SDK?** New code should use `@unbrowse/client`. Existing local-runtime integrations can keep using `@unbrowse/sdk` plus a running `unbrowse` runtime (`npx unbrowse setup`). Both SDKs are MIT.
- **Reading the OSS repo for architecture?** Treat it as a 2025 historical reference. Look here in `docs/` and at the public [whitepaper](./whitepaper/) for current behavior.
- **Filing a bug?** Use [github.com/unbrowse-ai/unbrowse/issues](https://github.com/unbrowse-ai/unbrowse/issues) for SDK/CLI issues. The CLI binary tracks current production.
- **Want source access for security review?** Email security@unbrowse.ai. Code review under NDA is available for serious enterprise integrators.

## Why we made this call

We shipped fully open until April 2026. Two patterns forced the change:

1. **Forks-as-scrapers.** Several forks rebranded the indexer and removed marketplace-publish, paid-routes, and ToS gates — turning a benign discovery tool into an unattributed scraping fleet.
2. **Platform integrity escalation.** Publishing low-level evasion details creates a race that harms legitimate users and site owners.

We still believe in giving agents real APIs. Closing the source is a tradeoff we made to keep that promise sustainable, not a permanent posture.
