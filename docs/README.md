# Unbrowse Docs

Canonical companion docs for the Unbrowse stack. Public site: [docs.unbrowse.ai](https://docs.unbrowse.ai).

> **Heads up — see [OPEN-SOURCE-NOTICE.md](./OPEN-SOURCE-NOTICE.md).** The public OSS repo is a frozen snapshot. Current production builds are closed-source for safety reasons.

## Start here

- [Quickstart](./guides/quickstart.md) — install, register, first resolve
- [API Reference](./api.md) — local server routes, marketplace endpoints
- [Deployment](./deployment.md) — release flow, Cloudflare topology

## SDK & onboarding

- [SDK package](../packages/sdk/README.md) — `@unbrowse/sdk` TypeScript client
- [SDK docs](../packages/sdk/docs/) — getting started, API reference, examples
- [Build on Unbrowse](./sdk/build-on-unbrowse.md) — archetypes, composition patterns, build phases, extension points
- [Onboarding validators](./sdk/onboarding-validators.md) — for clients running swarms of agents that mine routes for rewards
- [Onboarding users](./sdk/onboarding-users.md) — single-operator mining flow
- [Rewards & economics](./sdk/rewards-and-economics.md) — x402, splits, payouts
- [Frontend dashboard plan](./frontend-dashboard-plan.md) — IA + visualizations + build phases for `unbrowse.ai/dashboard`
- [Rewards & economics](./sdk/rewards-and-economics.md) — x402, splits, payouts

## Architecture

- [Capture & DAG](./architecture-capture-and-dag.md) — how passive capture builds the skill graph
- [Endpoint as cell](./endpoint-as-cell.md) — the cellular model of skills
- [Deep reverse-engineering](./deep-reveng.md) — multi-source extraction (network, JS heap, SSR, DOM)
- [ZK proofs](./zk-proofs.md) — `commitment_only` proof scope and trust boundary
- [Workflow harness](./workflow-harness.md) — workflow trace collection

## Whitepaper

- [Companion docs](./whitepaper/README.md) — implementation-aware companion to the published paper
- Canonical PDF: [`whitepaper/unbrowse-whitepaper.pdf`](./whitepaper/unbrowse-whitepaper.pdf)

## Releases & ops

- [Releasing](./RELEASING.md)
- [Most recent release notes](./release-2026-05.md)
- [PR validation matrix](./pr-validation-matrix.md)
- [GitHub webhook PR bot](./github-webhook-pr-bot.md)
- [Codex eval harness](./codex-eval-harness.md)
- [Capability harness](./unbrowse-capability-harness.md)

## GTM

- [Master plan essay](./gtm/master-plan-essay.md)
- [Launch pack](./gtm/2026-04-03-launch-pack.md)

## Archive

Historical regression notes and old planning docs are kept under [`archive/`](./archive/) for reference. They are not current product truth.
