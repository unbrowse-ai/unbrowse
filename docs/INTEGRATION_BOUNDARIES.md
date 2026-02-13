# Integration Boundaries and External Contracts

This repo has two operating components:
- Extension component: local capture/replay and skill artifacts.
- Marketplace component: publish/search/install and shared execution contracts.

This document exists so contributors do not leak internal behavior into public docs.
Only boundary behavior that is contract-safe should be documented.

## Core rule

Treat any non-local execution engine as external.
Document the contract it exposes, not the internals that implement it.

## Boundary map

Plugin to server
- plugin uses server routes for search, publish, install, and replay metadata
- server returns contracts and status in explicit response shapes
- missing optional fields must degrade safely

Server to marketplace
- server consumes/forwards against public marketplace routes
- install and execute are mediated through route contracts
- optional policy wrappers (including payment-related middleware) may apply

Server to web
- web reads same contract payloads used by plugin
- web renders trace, skill, analytics, and contributor data from route outputs
- no duplicated protocol logic

Auth/session boundary
- local session tokens stay local
- backend should receive only minimal, redacted payloads

## Explicit payments statement

Payments are not enabled in this repository stage.
Wallet routes may exist as placeholders, but paid settlement logic is inactive.
Do not document paid behavior as live.

## What we document

Documented:
- route endpoints and expected inputs
- response shape and optional/nullable fields
- visible error and fallback semantics
- publish merge and validation outcomes

Not documented:
- ranking internals
- settlement and payout internals
- hidden execution topology
- cost internal formulas and private anti-abuse loops

## Safe change policy

For any boundary change:
- identify the affected call sites across plugin/web/server files
- update docs in the same pass
- add tests for degraded and missing-field behavior
- update pre/post behavior notes if merge or execution flow changed

## API contract edit checklist

When a route changes:
- update the tool and web call sites together
- update `server/src/server/routes/README.md`
- update docs that consumers use in onboarding and onboarding summaries
- avoid assumptions beyond contract text
