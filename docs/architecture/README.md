# Architecture Docs — Start Here

> **At a glance** — six documents describing how Unbrowse actually works at
> v8.3.0-preview.2, generated from the code with every claim citing a real
> file path. Four describe the system (overview + one per surface); two
> define what "correct" means (acceptance criteria + test specs).

## Pick your reading path

| You want to… | Read |
|---|---|
| Get the whole system in 5 minutes | [OVERVIEW.md](./OVERVIEW.md) |
| Work on the CLI, MCP server, SDK, or local capture/replay engine | [CLI.md](./CLI.md) |
| Work on the API: routes, auth, keys, billing, marketplace | [BACKEND.md](./BACKEND.md) |
| Work on the web UI or the public metrics dashboard | [FRONTEND.md](./FRONTEND.md) |
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
