# Open Source Notice

**The public open-source Unbrowse repo at [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) is an outdated snapshot.** It does not reflect what current production builds do.

Later versions are **closed-source** because the local capture, indexing, and replay primitives that make Unbrowse work also create real abuse risk if shipped without guardrails:

- **Local session import** can be retargeted at accounts the operator does not own.
- **Route inference + replay** can be aimed at services that explicitly disallow automated access.
- **Marketplace publish + payout** plumbing is a financial path that can be steered into theft if the integrity of the indexer is compromised.
- **Platform integrity research** contains low-level details that we will not publish until they can be safely disclosed.

The split:

The split is three-way: the **frontend CLI is fully open source**, the **backend is
a private repo**, and the **frontend web app is private**.

| Surface | Where it lives | License / visibility |
|---|---|---|
| **Frontend CLI** — open client, SDKs & drop-in adapters (`@unbrowse/client`, `@unbrowse/sdk`, every `@unbrowse/*` shim + agent-SDK adapter) | npm + public repo | **MIT, fully open source** |
| `unbrowse` CLI launcher binary | npm `unbrowse` | distributed binary that wraps the private engine |
| Capture / indexing / replay **engine** | **private repo** | proprietary (the moat; ships only as the binary) |
| **Backend** (marketplace, payouts, settlement) | **private repo**, Cloudflare Workers | proprietary |
| **Frontend web app** (unbrowse.ai) | **private repo** | proprietary |
| Public OSS snapshot (older) | [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) | MIT, frozen |

The CLI you build against is fully open source (MIT) and carries no moat; trust in
the closed engine and backend is established by ZK + a hash-chained, auditable
ledger (see the reference implementation under `paper/reference/`), not by exposing
the server. The web app is a private product surface.

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
