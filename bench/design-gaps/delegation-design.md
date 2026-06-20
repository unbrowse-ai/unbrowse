# Non-custodial delegated-session-key funding (design)

> **Status:** DESIGN — public-WHAT-safe. No moat internals, no economic constants.
> Describes *what* the model is and *how* it maps onto existing Flex
> escrow + session-key primitives. Marks `[reuse]` (already ships) vs `[net-new]`.
> Date: 2026-06-20.

This is the design for letting an `api_key` pay x402 challenges **from a user's
own wallet/escrow** without the platform ever custodying the wallet's funds or
its private key — the non-custodial alternative to today's custodial-prepaid
deposit lane.

---

## 1. The problem

### Today: custodial-prepaid (the deposit lane)

The shipped wallet-funding lane is **custodial-prepaid**. The flow:

1. The wallet binds to a key: `POST /v1/account/keys/:keyId/funding {kind:"wallet"}`
   → `setKeyFunding(env, keyId, {kind:"wallet", wallet})`
   (`backend/src/routes/account.ts:225`, `backend/src/services/keys.ts:177`).
2. The wallet **deposits** USDC by signing ONE x402:
   `POST /v1/account/keys/:keyId/deposit` (`backend/src/routes/account.ts:291`).
   On a confirmed on-chain payment, `creditKeyWalletBalance` records the paid
   amount as a spendable `balance_uc` on the key
   (`backend/src/services/keys.ts:254`).
3. Every later call spends that prepaid balance via the always-on debit lane
   `debitKeyFunding` (`backend/src/services/keys.ts:284`, lane recognised at
   `backend/src/middleware/payment-admission.ts:144`).

The honest property and the honest cost:

- The platform **never holds the wallet's private key** — true in both models.
- But the deposited USDC **lands in the platform treasury ATA** (the deposit
  402's `payTo` is `platformRecipientUsdcAta(env)`,
  `backend/src/routes/account.ts:349`). The `balance_uc` on the key is an
  **IOU against treasury-held funds**. That is custody of *funds* (not of the
  key). The user must trust the platform's solvency and refund discipline for the
  unspent remainder.

### The non-custodial goal

The wallet's funds stay in **the wallet's own on-chain escrow**. The platform
gets a **bounded, expiring authorization** to draw from that escrow on the
wallet's behalf — never possession of the funds, never the wallet key, never
more than the delegated cap. Unspent funds are always in the user's escrow; the
"refund" is just *not drawing* and (optionally) closing the escrow back to the
wallet on-chain.

The good news: the on-chain machinery for exactly this **already ships**. The
gap is almost entirely off-chain plumbing (a bind step + a rolling cap ledger),
not new cryptography or a new on-chain program.

---

## 2. The mechanism

### The Flex escrow + session-key primitive (already the right shape)

Faremeter Flex is, structurally, a **non-custodial delegated-spend** primitive,
and unbrowse already drives it for the *sponsor* path:

> "Platform owns a SPONSOR escrow … A short-expiry sponsor session key (Ed25519)
> is registered to that escrow … this module signs a Flex authorization against
> the escrow." — `backend/src/services/sponsor-flex.ts:10-18`

The exact same three on-chain facts the sponsor path relies on are the facts the
**per-wallet** model needs, just with the *user's* wallet as the escrow owner
instead of the platform:

1. **An escrow PDA owned by the funder.** Funds live in the escrow; the owner is
   the only one who can create/close it. SDK: `fundEscrow` /
   `buildEscrowCreationTx` (`packages/sdk/src/flex.ts:80`), intent
   `create_escrow_and_deposit` (`packages/sdk/src/flex.ts:122`). The user signs
   this with their own wallet — the platform never does.
2. **A session key (bare Ed25519) registered to that escrow**, with an
   **expiry slot** and a **revocation grace period**. SDK:
   `registerSessionKey` with `expiresAtSlot` + `revocationGracePeriodSlots`
   (`packages/sdk/src/flex.ts:100-109`, `packages/sdk/src/flex.ts:480`). Session
   keys "carry NO intrinsic expiry metadata … track the expiry slot out-of-band"
   and have a documented hard cap (~96h) to "limit blast-radius of a leaked
   session key" (`backend/src/services/sponsor-session-key.ts:6-37`).
3. **A per-authorization `maxAmount` cap, enforced on-chain.** Every Flex
   authorization carries `maxAmount` (µ¢) the facilitator may draw, and the
   on-chain program rejects an over-draw. `buildFlexAuthorization` validates
   `maxAmountUc >= 1` and the splits sum (`backend/src/services/flex.ts:312`);
   the signed authorization shape is `{escrow, mint, maxAmount, authorizationId,
   expiresAtSlot, splits[], sessionKey, signature}`
   (`packages/sdk/src/flex.ts:34-51`). `authorizationId` is a random u64 for
   replay protection.

So "a session key registered to an escrow signs bounded authorizations" is **not
net-new** — it is the running sponsor mechanism. The only structural change is
**whose escrow** the session key is registered against.

### Per-agent escrow vs sponsor escrow

Two escrow ownership models already coexist; the delegated model adds a third
that reuses the first's shape:

| Escrow | Owner | Signer | Status |
|---|---|---|---|
| **Sponsor escrow** | platform | platform session key | `[reuse]` ships (`sponsor-flex.ts`); platform pays from its own escrow. |
| **Per-agent escrow** | the agent's own wallet | agent's session key (client-side) | `[reuse]` ships — `flex_escrow_address` + `flex_session_key_address` on the `AgentProfile` (`backend/src/types.ts:595`), gated at onboarding (`backend/src/middleware/flex-onboarding-required.ts`), authored into 402s by `respondWithFlexTerms` (`backend/src/services/flex-route-helpers.ts:64`). The agent self-pays its own 402 from its own escrow; the platform only emits terms and verifies. |
| **Delegated per-wallet escrow** | the **user's** wallet | a session key the **platform/key** holds, bounded by a cap | `[net-new]` plumbing. Same escrow shape as per-agent, but the session key is delegated *to the platform* so the `api_key` (not an interactive client) can sign within the cap. |

The delegated model is the per-agent escrow with one inversion: instead of the
**owner's interactive client** signing each authorization (today's `flex-pay.ts`
contract: "The signer is delegated to the lobster/crossmint wallet that owns the
session key; we never see the private key", `src/payments/flex-pay.ts:41`), the
owner **delegates a bounded session key to the platform** so the headless
`api_key` can sign on the wallet's behalf — within the cap, until expiry,
revocable on-chain.

---

## 3. The flow

```
  ┌─ user's wallet (PK never leaves the user) ─────────────────────────┐
  │                                                                     │
  │  (a) create + fund escrow      (b) register session key            │
  │      fundEscrow()                  registerSessionKey({            │
  │      → escrow PDA, owner=wallet      escrowAddress,                │
  │        funds live HERE              sessionKeyAddress,             │
  │                                     expiresAtSlot,                 │
  │                                     revocationGracePeriodSlots })  │
  │      [user signs both with own wallet — platform never signs]     │
  └─────────────────────────────────────────────────────────────────┘
                    │ session-key secret (or a platform-held delegated key)
                    ▼
  (c) BIND to api_key:  POST /v1/account/keys/:keyId/delegation
        { wallet, escrow, session_key_address, cap_uc, expires_at_slot }
        → setKeyFunding(keyId, {kind:"delegated", ...})   [net-new variant]
                    │
                    ▼
  (d) execute time — key calls a paid route, gets a Flex 402:
        admitPayment → lane "delegated"   [net-new lane, mirrors "wallet"]
        platform signs a Flex authorization against the USER's escrow:
          maxAmount = min(this-call price, remaining cap)
          escrow    = user's escrow      splits = verbatim 402 terms
          sessionKey/signature = the delegated session key
        → debit the rolling delegation-cap ledger by the settled amount
                    │
                    ▼
  (e) on-chain settle via the EXISTING facilitator path
        (handleFlexPaymentAuthorized, flex-route-helpers.ts:148)
        funds move FROM the user's escrow TO the split recipients.
        Platform treasury only ever appears as the ~10% infra split,
        never as the custodian of principal.
```

Key invariants of the flow:

- **No platform custody of funds.** The source of every draw is the user's
  escrow PDA (`escrow` in the authorization = user's escrow, not treasury). The
  treasury only receives its `infrastructure` split bps like any other recipient
  (`backend/src/services/flex.ts:39,244`).
- **No platform custody of the wallet key.** The wallet signs only the escrow
  create/fund + the session-key registration (steps a/b) with its own key. What
  the platform holds afterward is a **session key**, not the wallet key — a
  capability, attenuated by cap + expiry + on-chain revocation.
- **The cap is enforced twice.** On-chain per authorization (`maxAmount`), and
  off-chain across many small authorizations (the rolling delegation-cap ledger,
  §5) so the *sum* of draws can't exceed what the user delegated even though each
  individual authorization is independently bounded.

---

## 4. Security

### What the platform CAN do with the delegated session key

- Sign Flex authorizations **against the user's escrow only** (the session key is
  registered to exactly one escrow on-chain).
- Draw **at most `maxAmount` per authorization** (on-chain enforced) and **at most
  the total delegated `cap_uc`** across the delegation window (off-chain ledger,
  §5).
- Only **until `expires_at_slot`** — an expired authorization is rejected on-chain
  (`expiresAtSlot` is a signed field;
  `backend/src/services/flex.ts:349`). Session keys carry a documented hard cap
  on lifetime (`sponsor-session-key.ts:36-37`).

### What the platform CANNOT do

- **Cannot move the principal.** It cannot withdraw escrow funds to itself; it can
  only authorize a Flex draw whose `splits` are the **verbatim, backend-computed
  402 terms** — the client/platform never recomputes splits
  (`src/payments/flex-pay.ts:10-12`, behaviorally pinned). The platform's own cut
  is the fixed `infrastructure` split, not arbitrary.
- **Cannot exceed the cap or the expiry.** Both are on-chain facts of the session
  key's registration; a leaked session key is blast-radius-bounded by design
  (`sponsor-session-key.ts:9`).
- **Cannot touch a different wallet's escrow.** The session key is registered to
  one escrow PDA; it has no authority anywhere else.
- **Cannot prevent revocation.** The user closes/rotates the escrow or lets the
  session key expire — unilaterally, on-chain, no platform cooperation needed
  (`revocationGracePeriodSlots`, `packages/sdk/src/flex.ts:106`).

### Revocation

Three independent revocation paths, any one sufficient:

1. **On-chain:** the wallet revokes the session key / closes the escrow. The
   `revocationGracePeriodSlots` parameter (`packages/sdk/src/flex.ts:106`) bounds
   how long an in-flight authorization can still settle after revocation.
2. **Off-chain bind removal:** `DELETE /v1/account/keys/:keyId/delegation`
   (mirrors the existing `clearKeyFunding`, `backend/src/services/keys.ts:183`),
   so the `api_key` stops attempting draws even before the on-chain key expires.
3. **Natural expiry:** at `expires_at_slot` the delegation is dead with no action.

### How this preserves the wallet-binding model (the paper)

The paper's central identity claim is **"the wallet is the identity … one key
signs every layer"** (`paper/crypto-was-all-you-needed.tex:267-280`) with an
asymmetry: *"The private key never leaves; what the world receives is a copy it
can check"* (`tex:302-307`). The delegated model is exactly the paper's
**capability-attenuation** residual made concrete:

> "Capability attenuation bounds what a delegated action may do." —
> `paper/crypto-was-all-you-needed.tex:697`

The wallet PK never leaves the user (it only signs the escrow/registration
locally — consistent with PRIVACY.md's *"credentials never leave the machine is a
construction, not a promise"*, `docs/architecture/PRIVACY.md:3`). What crosses to
the platform is **not the key but a bounded, expiring, revocable capability** —
the attenuated delegation the paper names. The session key is a child of the
identity, not the identity. This is strictly *more* faithful to the paper than
the custodial-prepaid lane, where principal sits in the treasury.

---

## 5. Build delta (phased)

The headline: ~80% of this is `[reuse]`. The on-chain primitives, the signing
path, the facilitator settle, the 402 emission, and the per-key funding KV
pattern all ship. The `[net-new]` work is one funding variant, one admission
lane, one bind route, and a rolling cap ledger.

### Phase 0 — `[reuse]` inventory (no code, just the pin)

- Escrow create/fund + session-key registration with expiry + revocation grace:
  `packages/sdk/src/flex.ts` (`fundEscrow`, `registerSessionKey`,
  `buildEscrowCreationTx`, `buildSessionKeyRegistrationTx`).
- Per-authorization on-chain cap + replay id: `buildFlexAuthorization`
  (`backend/src/services/flex.ts:312`), authorization shape
  (`packages/sdk/src/flex.ts:34`).
- Session-key Ed25519 signing against an escrow: `sendSponsorFlexPayment` +
  `signMessageWithSessionKey` (`backend/src/services/sponsor-flex.ts:151,263`).
- 402 emission against an escrow + verify/settle: `respondWithFlexTerms` +
  `handleFlexPaymentAuthorized` (`backend/src/services/flex-route-helpers.ts`).
- Per-key funding binding KV + always-on debit lane: `setKeyFunding` /
  `getKeyFunding` / `debitKeyFunding` (`backend/src/services/keys.ts`).
- Admission lane recognition: `admitPayment`
  (`backend/src/middleware/payment-admission.ts`).
- **Witness:** existing test suites already green for the sponsor escrow path
  and the per-agent escrow path.

### Phase 1 — `[net-new]` the delegation funding variant

Add a third `KeyFunding` discriminant alongside `{kind:"wallet"}` /
`{kind:"credit"}` (`backend/src/services/keys.ts:151`):

```ts
| { kind: "delegated";
    wallet: string;             // owner-of-record (the escrow owner)
    escrow: string;            // user's escrow PDA — the funds source
    session_key_address: string;
    cap_uc: number;            // total delegated cap (rolling ledger ceiling)
    spent_uc: number;          // running spend (the off-chain cap projection)
    expires_at_slot: string;   // mirrors the on-chain session-key expiry
    bound_at: string }
```

- **Witness:** unit test that the variant round-trips through KV; that
  `getKeyFunding` returns it; that a missing/expired delegation is unbound
  (null), exactly like an unfunded key — backward-compatible by construction
  (the same property the `wallet`/`credit` variants already have).

### Phase 2 — `[net-new]` the bind route

`POST /v1/account/keys/:keyId/delegation` (mirrors the existing funding route
`backend/src/routes/account.ts:225`):

- Accepts `{ wallet, escrow, session_key_address, cap_uc, expires_at_slot }`.
- **Proves wallet control** the same way the web3-PK bind path does — a signature
  challenge — reusing the hijack-hardened `setKeyWallet`
  (`backend/src/services/keys.ts:215`) so a delegation can't be bound to a wallet
  the caller doesn't control.
- Optionally **verifies on-chain** that the session key is registered to that
  escrow with the claimed expiry (read-only RPC) before accepting the bind.
- `DELETE` clears it (revocation path 2).
- **Witness:** route test — bind with a valid signature + on-chain check passes;
  bind to a foreign wallet refused; delete unbinds.

### Phase 3 — `[net-new]` the admission lane + signing wire

- Add lane `"delegated"` to `admitPayment`
  (`backend/src/middleware/payment-admission.ts`) immediately after the
  `kind:"wallet"` branch: a delegated key's `wallet` is the payer-of-record (same
  as the wallet lane) but it routes to the **escrow-signing** settle, not the
  prepaid debit.
- At settle time, reuse `sendSponsorFlexPayment`'s signing core
  (`backend/src/services/sponsor-flex.ts`) but parameterized on the **user's**
  escrow + the **delegated** session key instead of the sponsor's. Cap each
  authorization at `min(price, cap_uc - spent_uc)`.
- **Witness:** integration test — a delegated key hitting a paid route signs an
  authorization against the *user's* escrow (not treasury), with `maxAmount`
  clamped to remaining cap; settle path produces a tx; over-cap is refused.

### Phase 4 — `[net-new]` the rolling delegation-cap ledger

Each Flex authorization is independently `maxAmount`-bounded on-chain, but
nothing on-chain links *successive* authorizations to one delegated budget. So
the **sum** is enforced off-chain:

- After each confirmed settle, atomically `spent_uc += settled_amount` on the
  `delegated` funding record. This is the **append-only event-log + projection**
  pattern already adopted for the economic ledgers (see ledger-unification work)
  — the projection is `spent_uc`, the events are the settled authorizations
  keyed by `authorizationId` (idempotent on the replay id, so a double-count is
  impossible).
- Admission refuses a draw once `spent_uc >= cap_uc` (falls through to a per-call
  402, exactly like an exhausted prepaid balance does today,
  `backend/src/services/keys.ts:309`).
- **Witness:** test that N draws summing past `cap_uc` are refused at draw N;
  that the same `authorizationId` settling twice does not double-count (idempotent
  projection); that an expired `expires_at_slot` refuses all further draws.

### Phase 5 — `[reuse]` surfacing

- `/v1/account/keys` already returns `funding` per key
  (`backend/src/routes/account.ts:111`) — the `delegated` variant surfaces for
  free, showing `cap_uc`, `spent_uc`, remaining, and `expires_at_slot`.
- `/account/me` already surfaces `flex_escrow_address` / `flex_session_key_address`
  (`backend/src/routes/account.ts:72`) for the onboarding CTA.
- **Witness:** the existing account-route tests extend to assert the delegated
  fields render.

---

## 6. Custodial-prepaid vs delegated comparison

| Dimension | Custodial-prepaid (today) | Delegated session key (this design) |
|---|---|---|
| **Custody of funds** | Platform treasury holds the deposited USDC; `balance_uc` is an IOU (`account.ts:349`, `keys.ts:254`). | Funds stay in the **user's escrow PDA**; platform never holds principal. |
| **Custody of wallet key** | No (true in both). | No — platform holds only a bounded session key, not the wallet key. |
| **Trust assumption** | Trust platform solvency + honest refund of unspent balance. | Trust only the on-chain cap + expiry; trust-minimized (capability attenuation, paper `tex:697`). |
| **UX cost** | **One deposit** (one x402 sign) up front; spend is then headless. | **One delegation** (escrow fund + session-key register, signed once by the wallet); spend is then headless. Comparable one-time cost; no top-ups if escrow pre-funded. |
| **Settlement venue** | Per-call **KV decrement** of `balance_uc` (`debitKeyFunding`); on-chain only at the one-time deposit. | Per-call **on-chain Flex draw** from the user's escrow via the existing facilitator (`handleFlexPaymentAuthorized`). |
| **Refund of unspent** | Platform must actively refund the treasury-held remainder (operational + trust burden). | **No refund needed** — unspent funds are already in the user's escrow; user closes it on-chain. |
| **Revocation** | Revoke the key; reconcile the off-chain balance. | Revoke on-chain (close escrow / expire session key) **or** unbind off-chain — unilateral, no platform cooperation. |
| **Blast radius if platform compromised** | Treasury-held prepaid balances at risk. | Bounded to `cap_uc` per delegated key until expiry; principal stays in user escrows. |

---

## Recommended model (executive summary)

1. **Adopt the delegated session-key model as the non-custodial funding lane**,
   keeping custodial-prepaid as the simple opt-in default — they coexist as
   sibling `KeyFunding` variants, no breaking change.
2. **Reuse, don't rebuild:** the escrow + session-key + on-chain cap + Ed25519
   signing + facilitator settle all ship today (SDK `fundEscrow`/
   `registerSessionKey`, backend `sendSponsorFlexPayment`,
   `handleFlexPaymentAuthorized`). The model is the running *sponsor* escrow
   mechanism with the **user's** escrow as the source.
3. **Net-new is small and off-chain:** a `{kind:"delegated"}` funding variant, a
   `POST .../delegation` bind route (signature-proven, hijack-hardened via
   `setKeyWallet`), a `"delegated"` admission lane that signs against the user's
   escrow, and a **rolling cap ledger** (`spent_uc` projection, idempotent on
   `authorizationId`) so the sum of small draws can't exceed the delegated cap.
4. **Security is the paper's capability-attenuation made concrete:** wallet PK
   never leaves the user; the platform holds only a cap-bounded, expiring,
   on-chain-revocable session key against one escrow — never the principal,
   never the key.
5. **Strictly better trust posture than custodial-prepaid:** funds stay in the
   user's escrow, no refund/solvency trust, unilateral on-chain revocation, and
   blast radius bounded to the delegated cap.
