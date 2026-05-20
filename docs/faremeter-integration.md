# Faremeter (ABK Labs Fair Meter) Integration Status & Roadmap

Status as of 2026-05-20. This doc exists so the next agent does not
re-implement what is already shipped on the server side of the
Faremeter / x402 integration and so the remaining client-side gap is
visible.

## Source citations

Context for this doc comes from two external sources, cited so a later
agent can re-pull them. Per project context-gathering rule, model
memory is not a source.

- deepwiki `faremeter/faremeter`, the three-tier x402 architecture
  documented by the upstream repo: `@faremeter/fetch` (client wrap),
  `@faremeter/middleware` (server enforcement), `@faremeter/facilitator`
  (settle). Solana + EVM rails, wallet-agnostic, supports Crossmint.
- 2026-05-19 ABK call (reference only, generically, no note ids or
  participant PII per project PII rule). Recommended a four-piece
  architecture: dockerized Fair Meter marketplace (self-host,
  discoverable via pay.sh); Flex for custom payment logic with
  basis-point markup; Corbits CLI for API discovery; Lobster Cash /
  MoonPay for wallet + fiat ramp.

## What is already shipped (server side)

`grep -rl faremeter backend/` returns 93 hits across 35 files. The
server side is not a spike, it is shipped infrastructure.

### Installed Faremeter packages

From `backend/package.json`:

- `@faremeter/middleware@^0.21.0`, server-side x402 enforcement.
- `@faremeter/payment-solana@^0.21.0`, Solana payment rail.
- `@faremeter/flex-solana@^0.2.1`, Flex Solana basis-point markup.
- `@faremeter/types@^0.21.0`, shared types.

Not yet installed: `@faremeter/fetch` (client-side `wrap()`). This is
the actual remaining gap; see "Remaining gap" below.

### Backend services that already exist

- `backend/src/services/flex.ts`, Flex top-level wiring.
- `backend/src/services/flex-facilitator.ts`, Flex facilitator client
  for `/settle`.
- `backend/src/services/flex-payment-terms.ts`, payment-terms
  construction.
- `backend/src/services/sponsor-flex.ts`, sponsor middleware's Flex
  arm (already integrates Flex with the per-agent + per-platform USD
  cap sponsor tier documented in CLAUDE.md).
- `backend/src/services/meter-on-execute.ts`, meter ring tied to
  execute calls.
- `backend/src/services/stripe-meter-ring.ts`,
  `stripe-tier-detection.ts`, `stripe-grants.ts`, Stripe x402 arm
  (the universal LLM proxy uses Stripe x402; Faremeter Flex/Solana
  arm is the parallel skill-route monetization rail; the comment at
  `backend/src/index.ts:65` makes this explicit).
- `backend/src/services/rail-rotation.ts`, switches between rails.

### Backend middleware

- `backend/src/middleware/sponsor.ts`, existing sponsor tier (per-agent +
  per-platform daily USD caps), KV-backed at `sponsor:agent:<id>:<UTC-date>`,
  `sponsor:global:<UTC-date>`, `sponsor:ledger:<id>`. Already coexists
  with the Faremeter Flex skill routes. Do not rip out.
- `backend/src/middleware/x402-gate.ts`, generic x402 gate primitives:
  `paymentsEnabled`, `searchPaymentsEnabled`, `x402UseTestnet`.
- `backend/src/middleware/flex-onboarding-required.ts`,
  `flex-onboarding-soft-block.ts`, Flex onboarding flow gates.

### Backend test coverage

13 test files exercise the Faremeter / Flex surface end-to-end:

- `flex-end-to-end.test.ts`
- `flex-facilitator.test.ts`
- `flex-metered.test.ts`
- `flex-onboarding.test.ts`
- `flex-owner-bps-edges.test.ts`
- `flex-owner-bps.test.ts`
- `flex-payment-terms.test.ts`
- `flex-registration.test.ts`
- `flex-route-swap.test.ts`
- `flex-splits-50-50.test.ts`
- `sponsor-flex-caps.test.ts`
- `sponsor-flex.test.ts`
- `x402-llm-flex.test.ts`

The basis-point markup, owner-bps splits, route-swap, and end-to-end
paid round-trip on the server side all have live tests. A new spike
on the server would duplicate these.

## Remaining gap (the honest WAVE-1 surface)

The plan_text describes WAVE 1 as standing up a `@faremeter/fetch`
client call against a server `@faremeter/middleware` endpoint with
devnet settlement. The server side of that is shipped. What is not
shipped is the **agent-side client wrapper**.

A calling agent today must either:

- Hand-construct the X-PAYMENT header (sign a payment intent against
  its Solana keypair, encode per x402 spec, attach to the retry).
- Or use raw `x402-axios` / similar that does not match what
  `@faremeter/middleware` issues on the server.

Adding `@faremeter/fetch` (deepwiki: `faremeter/faremeter` package
`packages/fetch`) inside `@unbrowse/sdk` would close this loop:

```
agent --> @unbrowse/sdk.execute
       --> @faremeter/fetch.wrap(globalThis.fetch, { signer })
       --> POST /v1/skills/.../execute
       --> 402 with PAYMENT-REQUIRED (already issued by @faremeter/middleware)
       --> retry with X-PAYMENT header
       --> 200 with execute result + PAYMENT-RESPONSE
```

The signer would be an existing user wallet (Crossmint, Lobster Cash,
or any Solana keypair); per deepwiki the wrap() is signer-agnostic.

This is the smallest deliverable that produces "a real x402 paid
round-trip on devnet" end-to-end without re-implementing the server
side. The harness verify_gate at
`.claude/integrate-abk-labs-fair-meter-faremeter-x402-pay.local.md`
already names this exact round-trip as the success criterion.

## Other pieces from the ABK call (not WAVE 1)

These remain downstream and intentionally out of scope for the
client-fetch wrap:

- Dockerized Fair Meter marketplace (self-host, pay.sh discovery) ,
  requires ABK to ship setup guidance.
- Corbits CLI for API discovery, adjacent to unbrowse's existing
  marketplace publish-on-execute flow; needs separate evaluation
  whether it duplicates or extends.
- Lobster Cash / MoonPay for fiat ramp, already connected on the
  user side (per the ABK call); not a backend integration.

## Substrate notes

This doc is evidence (what exists, what is missing, why). It does not
bake a verdict, a heuristic, a per-domain registry, or a banned list.
The next agent reads this, judges what to ship next in-thread, and
either:

- Ships `@faremeter/fetch` into `@unbrowse/sdk` against an existing
  Flex-protected skill route (WAVE 1 proper), or
- Pulls the dockerized marketplace once ABK ships setup, or
- Re-judges scope if upstream Faremeter package versions have moved.

Everything cited above is checkable: each backend file path is real
on this commit; the deepwiki source can be re-pulled.
