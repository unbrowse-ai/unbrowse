# Architecture Docs — Start Here

> **At a glance** — documents describing how Unbrowse actually works at
> v9.4.12, generated from the code with every claim citing a real file path.
> Four describe the system surfaces (overview + CLI/backend/frontend), four are
> cross-cutting deep-dives (security, privacy, auth, performance), and two
> define what "correct" means (acceptance criteria + test specs). For the full
> repo index see [../CATALOGUE.md](../CATALOGUE.md).

## Pick your reading path

| You want to… | Read |
|---|---|
| Get the whole system in 5 minutes | [OVERVIEW.md](./OVERVIEW.md) |
| Find any doc or any code subsystem | [../CATALOGUE.md](../CATALOGUE.md) |
| Work on the CLI, MCP server, SDK, or local capture/replay engine | [CLI.md](./CLI.md) |
| Work on the API: routes, auth, keys, billing, marketplace | [BACKEND.md](./BACKEND.md) |
| Work on the web UI or the public metrics dashboard | [FRONTEND.md](./FRONTEND.md) |
| Understand anti-tamper, anti-bot, the trust graph, the x402 gate | [SECURITY.md](./SECURITY.md) |
| Understand secret handling and the thin-client guarantee | [PRIVACY.md](./PRIVACY.md) |
| Understand identity, keys, auth gating, wallet resolution | [AUTH.md](./AUTH.md) |
| Understand why it's fast: caching, egress tiering, fast paths | [PERFORMANCE.md](./PERFORMANCE.md) |
| Know what a subsystem must do before changing it | [ACCEPTANCE-CRITERIA.md](./ACCEPTANCE-CRITERIA.md) |
| Write or find tests; see coverage and gaps | [TEST-SPECS.md](./TEST-SPECS.md) |

## The 12 subsystems (one index for both quality docs)

Acceptance criteria and test specs share the same 12 numbered sections, so
§N in one maps to §N in the other:

| § | Subsystem | Criteria tags |
|---|---|---|
| 1 | Authentication (magic link) | AC-AUTH |
| 2 | API keys | AC-KEY |
| 3 | Key funding — API key wraps the wallet | AC-FUND |
| 4 | Stripe subscriptions | AC-STR |
| 5 | Crypto (USDC) subscriptions | AC-CSUB |
| 6 | Per-request x402 payments | AC-X402 |
| 7 | Sponsored free tier | AC-SPON |
| 8 | Wallets & OWS | AC-WAL |
| 9 | Marketplace: publish / verify / claim | AC-MKT |
| 10 | Earnings & discovery attribution | AC-EARN |
| 11 | CLI / MCP core loop | AC-CLI |
| 12 | Frontend (product UI) | AC-FE |

## Conventions

- **Citations**: every factual claim names the implementing file
  (`path/to/file.ts`). If a citation has gone stale, fix the doc.
- **Honesty**: known gaps and unimplemented features are stated as such —
  these docs describe what exists, not what is planned.
- **Mirror**: this set is mirrored to the team wiki (Architecture —
  Unbrowse Ecosystem collection); the repo copy is canonical.
