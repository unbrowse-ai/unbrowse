# Architecture Deep Dive

This is the canonical technical map of how Unbrowse works.
It is written for developers who need to trace behavior changes safely.

## System goal in plain terms

Unbrowse converts browser traffic into structured, reusable skills.
A skill starts as local data and becomes shared only if explicitly published.

The system is organized around two components:
- Extension component: `packages/plugin`
- Marketplace component: `server` + `packages/web`

## Core operating model

Unbrowse is split by trust and execution scope:

Extension domain: `packages/plugin` writes and replays from local files.
Marketplace domain: `server` + `packages/web` validates and exposes publish/search/execute contracts.

The marketplace itself is a contract boundary. This repository documents contracts, not internal execution topology.

## Architecture map

```text
OpenClaw user/tool call
  -> plugin command (capture/search/replay/publish)
  -> local skill files in ~/.openclaw/skills/<service>/
  -> optional local replay
  -> optional server publish/search
  -> optional backend execution via marketplace contract
  -> result + trace metadata back to caller
```

## Execution mode decision

`unbrowse_replay` chooses one of two modes:

Local mode
- skill exists only in local files
- endpoints can be replayed with local scripts and local auth/session context

Backend mode
- skill is published and mapped to shared endpoint IDs
- execution goes through `/marketplace/endpoints/:endpointId/execute`
- results include trace metadata where available

The mode is chosen per call, not globally for the whole system.

## Files by boundary

### Plugin boundary

Primary files:
- `packages/plugin/index.ts`
- `packages/plugin/src/plugin/plugin.ts`
- `packages/plugin/src/plugin/tools`
- `packages/plugin/src/har-parser.ts`
- `packages/plugin/src/skill-generator.ts`
- `packages/plugin/src/skill-package-writer.ts`
- `packages/plugin/src/skill-index.ts`

Plugin scope:
- capture from CDP/HAR
- endpoint inference and normalization
- local artifact generation
- deterministic local merge updates
- local replay invocation

### Server boundary

Primary files:
- `server/src/server/routes.ts`
- `server/src/server/routes/*.ts`
- `server/src/server/ability-execution-service.ts`
- `server/src/server/skill-repository.ts`
- `server/src/server/endpoint-repository.ts`
- `server/src/server/skill-merge.ts`
- `server/src/server/ingestion.ts`
- `server/src/server/credential-service.ts`

Server scope:
- route contracts for plugin/web
- schema and auth checks
- publish merge and validation
- endpoint health updates
- trace capture for backend executions

Execution route behavior note:
- backend execution route: `POST /marketplace/endpoints/:endpointId/execute`
- execution returns canonical workflow steps and transition output
- request receives validation updates and endpoint health deltas
- traces can optionally feed LAM export pathways when enabled

## Server route surface (high-level)

Public routes
- `server/src/server/routes/public.ts`
- `server/src/server/routes/ingestion.ts`
- `server/src/server/routes/abilities.ts`

Marketplace routes
- `server/src/server/routes/marketplace.ts`
- `server/src/server/routes/execution.ts`

Infra/admin routes
- `server/src/server/routes/health.ts`
- `server/src/server/routes/analytics.ts`
- `server/src/server/routes/analytics-cost.ts`
- `server/src/server/routes/credentials.ts`

Execution and auth utilities
- `server/src/server/routes/tokens.ts`
- `server/src/server/routes/domains.ts`

### Web boundary

Primary files:
- `packages/web/`

Web scope:
- search/list/install flows
- contributor and analytics views
- route contract-driven rendering

## Data movement step-by-step

Step 1 capture
- user captures traffic or loads HAR
- parser extracts candidate calls

Step 2 generate
- generator writes `SKILL.md`, scripts, and local metadata

Step 3 merge local
- repeated captures for same service are merged deterministically

Step 4 replay local
- local execution path used by default when artifacts are present

Step 5 optional publish
- local package sent to server for validation and merge

Step 6 optional install/search
- published versions become discoverable in remote contract surface

Step 7 optional backend replay
- server executes and returns execution observability

## Local artifacts: what is stored and why it matters

Each local skill can include:
- `SKILL.md`
- `scripts/`
- `references/`
- `auth.json`
- `ENDPOINTS.json` (mapping output for execution context)

Local artifacts are deterministic so they are stable for debugging, diffing, and reproducible local replay.

## Merge model (critical for contributors)

There are two merge points:

Local merge
- same capture service repeated
- de-dupe endpoint candidates

Server merge
- new publish against existing service/version
- canonicalization + compatibility checks
- novelty/confidence calculations for contribution metadata

For both:
- deterministic order is important
- merge behavior changes can alter replay behavior
- every parser/inference change must include merge-safe regression coverage

## Security and trust

No raw local auth should be required in published payloads.
Credentials are intended to stay local unless the user explicitly opts into separate flows.
Published execution uses explicit boundaries and redaction where applicable.

## What is documented and what is not

Documented here:
- route contracts, inputs, outputs
- validation and error semantics
- observable execution metadata
- merge behavior that can be reasoned about by artifacts

Not documented:
- internal marketplace ranking internals
- settlement or partner execution topology
- private anti-abuse and scaling internals

## Why this architecture exists

Local-first keeps first-run fast and private.
Publishing enables discovery and shared use without forcing paid execution for base workflows.
This split is what gives Unbrowse both developer velocity and ecosystem reuse.

## Change impact quick check

If you change parser or merge behavior:
- update merge expectations in this document
- update relevant route/docs for any contract shifts
- add conflict regression cases
- include replay impact in notes

If you change server route contracts:
- update `server/src/server/routes/README.md`
- update plugin call sites that consume those contracts
- update any affected docs in `docs/`
