# Faremeter substrate decision — ADOPT (shipped)

Status: **DECIDED — ADOPT** (shipped in `packages/sdk/src/flex.ts` against
`@faremeter/flex-solana@0.2.1`).

Contract: `4c518bd8` (frontend-banger DEFERRED row, intent #16).
Linked plan: `1a80cffd` (FAREMETER-FLEX-SPLITS-IMPL),
`5198fac2` (FAREMETER-FLEX-INTEGRATION), `3dc7494e` (FAREMETER-TENCENT-SELFHOST).

## Context

Lewis pasted faremeter docs as the fairness substrate for x402-shaped paid
agent calls (variable-cost endpoints, three-recipient default splits between
indexer / requester / platform, escrow + session-key authorization model).
The open question was: **adopt @faremeter/flex-solana wholesale, or ship our
own split-and-settle logic on top of bare x402?**

## Decision

ADOPT `@faremeter/flex-solana` as the canonical Flex payment scheme in
`@unbrowse/sdk`. Concrete evidence:

- `packages/sdk/package.json` declares `@faremeter/flex-solana@^0.2.1` as an
  optional dependency (tree-shake-preserving — SDK callers who never sign
  Flex authorizations don't pull `@solana/kit` ~3MB).
- `packages/sdk/src/flex.ts` (454 LOC) wires the full Flex surface:
  `buildFlexAuthorization`, `payAndRetryFlex`, `buildEscrowCreationTx`,
  `buildSessionKeyRegistrationTx`, `fundEscrow`, `registerSessionKey`.
  All package references go through `await import("@faremeter/flex-solana")`
  inside function bodies (tree-shake invariant).
- Wire shapes match the package's exported types verbatim:
  `FlexPaymentPayload`, `FlexPaymentRequirementsExtra`, `SplitInput` from
  `@faremeter/flex-solana/types` and `/authorization`.
- The recommended wallet path on the user-facing `/account/wallet` page is
  lobster.cash → fund Flex escrow (the Crossmint custodial wallet that
  auto-handles escrow + session-key registration on top of Faremeter Flex).

## Criteria evaluated

| Criterion | Adopt Faremeter | Ship our own splits |
|---|---|---|
| Time-to-paid-agent-call | hours (the SDK shape is the package shape) | weeks (re-implement escrow + session-key + Ed25519 verify on Solana) |
| Three-recipient default splits | native (SplitInput[], bps sums to 10000) | re-implement |
| Variable-cost endpoint settle | native (Flex `createUptoHandler`) | re-implement |
| Audit surface | shared audit with other Faremeter consumers | bespoke, one-of-one |
| Risk if Faremeter pivots | medium — pin minor, vendor escape hatch in flex.ts | n/a |
| Compatibility with @unbrowse/sdk tree-shake | preserved via lazy `await import` | n/a |

Adopt wins on every line except "risk if Faremeter pivots", which we
mitigate by (a) pinning `^0.2.1` (minor-version lock), (b) keeping every
Faremeter import inside lazy function bodies so swapping schemes is a
1-file change, (c) the Flex wire shapes are documented contracts not
internal package details — any drop-in compatible facilitator works.

## What "ADOPT" means concretely

1. **SDK surface**: `payAndRetryFlex` (`flex.ts:200`) is the canonical
   way callers retry a 402 with a Flex-signed authorization. Tree-shake
   is preserved.

2. **Wallet UX**: `/account/wallet` page (`frontend/src/app/account/wallet/page.tsx`)
   offers three pairing paths: lobster.cash (recommended, auto-handles
   escrow), BYO Solana wallet, and MoonPay on-ramp (preview). All three
   pair the same Solana address that signs Flex authorizations.

3. **Backend**: settlement happens through a Faremeter facilitator. The
   open child contract `3dc7494e` (FAREMETER-TENCENT-SELFHOST) ships a
   self-hosted facilitator so we are not dependent on a third-party
   facilitator's uptime. The Flex authorization scheme itself stays
   identical.

4. **Splits**: the open child contract `1a80cffd` (FAREMETER-FLEX-SPLITS-IMPL)
   wires `createUptoHandler` with three-recipient default splits per
   `docs/public/primitives/07` (indexer / requester / platform).

5. **Roadblock escalation**: the open child contract `6110f449`
   (ROADBLOCK-ESCALATION-PRIMITIVE) defines what happens when the
   Faremeter facilitator is not on mainnet — fallback to alternative
   payment rails (PayAI, agentcash.dev, lobster.cash CLI), exposed via
   `GET /v1/billing/topup-needed`.

## Open follow-ons (separate contracts, not blockers)

- `5198fac2` — wire `@faremeter/payment-solana/flex/facilitator` for
  variable-cost endpoints. Open.
- `1a80cffd` — wire `createUptoHandler` with three-recipient
  `defaultSplits`. Open.
- `3dc7494e` — deploy Faremeter facilitator on Tencent SSH host with
  systemd unit. Open.
- `f1616303` — wire Pay signer and `agentcash.dev` as additional
  `accepts[]` entries in the 402 envelope alongside Flex (rail
  redundancy). Open.

## Reversal trigger

If `@faremeter/flex-solana` ships a breaking 1.0 that changes the
authorization wire shape, AND no compatibility shim exists, AND the
roadblock escalation surface (`6110f449`) has accumulated >30% fallback
traffic for a sustained week — reopen this decision. Otherwise the
substrate stays.

## References

- Faremeter docs: `https://docs.faremeter.xyz/llms.txt`
- SDK Flex wiring: `packages/sdk/src/flex.ts:1-454`
- Package dep declaration: `packages/sdk/package.json` `optionalDependencies`
- Wallet UX: `frontend/src/app/account/wallet/page.tsx`
- Backend facilitator (open): contract `3dc7494e`
