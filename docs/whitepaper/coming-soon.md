# Coming Soon

This page lists parts of the paper that are not in the hosted service today, or not in the form the paper describes.

It does not cover what already ships: the flat meter (500 verified calls a month free, then $10 per 10,000). See [System Today](./system-today.md).

Nothing here has a date. Read it as direction.

## Route economy

- prices set per route
- fee ceilings tied to rediscovery cost
- dynamic pricing by confidence, freshness and demand
- multi-party fee splits per call

## Contributor economics

- attribution for who taught or fixed a route
- payouts to contributors and maintainers
- delta-based attribution for route improvements
- anti-Sybil attribution

Routes users teach are shared to the public registry today, but carry no attribution or payout.

## Site-owner compensation

- domain registration by site owners
- opt-in payment routing to site owners
- websites priced as usage-metered endpoints

## Trust infrastructure

The service has a practical trust model: verified outcomes, run-ledger health, a publish gate and revalidation. These stronger pieces do not exist:

- signed feedback
- validator attestations and validator markets
- staking and slashing
- cryptographic proof of route verification
- sandbox (E2B) or TEE-backed attestation

## Identity-bound credentials

A design where a session is bound to the user's public-key identity, committed to a ledger with an expiry, and unlocked by a wallet signature at replay. Not built. Today's credential model is the vault described in [Credential Sovereignty](./credential-sovereignty.md).

## Packaging

The paper describes per-route bundles with `SKILL.md`, `auth.json` and a generated `api.ts`. Today each capability is harness YAML plus a SKILL.md, and each site is an MCP server and an OpenAPI document. There is no `auth.json` or generated client per route.

## A general route graph

The paper describes a shared graph of routes, including writes. The public registry today holds read-only lookups. Multi-step flows, including writes, live inside a single workspace's capabilities.

## How to read these sections

When the paper describes these systems, read them as research framing and product direction. Do not read them as available unless [System Today](./system-today.md) lists them.
