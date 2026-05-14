# Migrating from v6.15 to v6.16: x402 `exact` → Faremeter Flex

If you integrated Unbrowse before v6.16, your callers signed `exact`-scheme
x402 payments against the hosted Corbits facilitator. v6.16 replaces that
end-to-end with `@faremeter/flex`. This page covers what changed, what your
client needs to do differently, and where to look in the SDK.

The wire format is still x402 over HTTP — the server still replies `402` with
`accepts[]` and the client still attaches `X-PAYMENT`. Only the `scheme` and
the `extra` payload shape change.

## What changed

| Surface | v6.15 (Corbits + exact) | v6.16 (Faremeter Flex) |
|---|---|---|
| Scheme id in `accepts[].scheme` | `"exact"` | `"@faremeter/flex"` |
| Splits | Provisioned externally via Cascade splits SDK; on-chain 1% protocol fee | Native in every authorization — up to 5 recipients, bps summing to 10000, atomic distribution |
| Signing key | Custodial wallet signs every settlement | Session key (Ed25519) signs authorizations; custodial wallet only signs escrow create + session-key register |
| Settlement cadence | One on-chain `/settle` round-trip per request | Off-chain authorization + batched on-chain flush |
| Variable-cost endpoints | Not supported (`exact` requires up-front amount) | `createUptoHandler` — authorize a ceiling, settle the actual amount used |
| Facilitator | `https://facilitator.corbits.dev` (hosted) | `backend/src/services/flex-facilitator.ts` (self-hosted by Unbrowse) |
| Platform fee mechanism | Cascade split with 10% platform share | `PLATFORM_BPS = 1000` (10%) in the same authorization |
| Sponsor mode payment | Direct USDC SPL transfer | Same Flex authorization shape, signed against a platform sponsor escrow (opt-in via `SPONSOR_USE_FLEX_SPLIT=1`) |

## If you call us via SDK

Your old code throwing on 402 still works — `PaymentRequiredError` is
unchanged. What changed is which `payAndRetry*` you call:

```ts
// v6.15 — exact scheme via lobster x402
import { Unbrowse } from "@unbrowse/sdk";

const ub = await Unbrowse.local();
try {
  const result = await ub.execute("skill_id", { ... });
} catch (e) {
  if (e instanceof PaymentRequiredError) {
    return await payAndRetry(e, lobsterWallet);   // exact-scheme retry
  }
  throw e;
}
```

```ts
// v6.16 — Flex authorization signed with your session key
import { Unbrowse, payAndRetryFlex } from "@unbrowse/sdk";
import type { FlexWalletLike } from "@unbrowse/sdk";

const ub = await Unbrowse.local();

// FlexWalletLike: { address(): string; signMessage(bytes: Uint8Array): Promise<Uint8Array>; }
const wallet: FlexWalletLike = {
  address: () => "<your-session-key-pubkey-base58>",
  signMessage: async (bytes) => /* Ed25519-sign with your session key secret */,
};

try {
  const result = await ub.execute("skill_id", { ... });
} catch (e) {
  if (e instanceof PaymentRequiredError) {
    return await payAndRetryFlex(e, wallet, async (paymentHeader) => {
      // re-issue the original execute with X-PAYMENT attached
      return await ub.execute("skill_id", { ... }, { headers: { "X-PAYMENT": paymentHeader } });
    });
  }
  throw e;
}
```

For metered routes the high-level helper handles the retry for you:

```ts
// packages/sdk/src/client.ts:447 — Unbrowse#executeMetered
const result = await ub.executeMetered<{ data: string; usage_units: number }>(
  "skill_id",
  { prompt: "..." },
  {
    wallet,                              // FlexWalletLike — used only on 402
    onUsage: (units) => console.log("consumed", units, "units"),
  },
);
```

`executeMetered` issues a `POST` to `/v1/skills/:id/execute`, catches a
`PaymentRequiredError`, lazy-imports `payAndRetryFlex`, signs the
authorization for the ceiling, retries with the `X-PAYMENT` header, and
fires `onUsage` if the response carries a numeric `usage_units`. The
lazy import preserves the SDK's tree-shake story — callers that never hit
a paid route never pull `@faremeter/flex-solana`.

Constructing an authorization without dispatching it:

```ts
// packages/sdk/src/flex.ts:162 — buildFlexAuthorization
import { buildFlexAuthorization } from "@unbrowse/sdk";

const auth = await buildFlexAuthorization({
  escrow:          "<your-escrow-pda>",
  mint:            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  maxAmount:       "10000",            // 0.01 USDC ceiling
  authorizationId: "<u64 base10>",     // random; SDK helper available
  expiresAtSlot:   "<u64 base10>",
  splits: [
    { recipient: "<platform-usdc-ata>",    bps: 1000 },
    { recipient: "<contributor-usdc-ata>", bps: 9000 },
  ],
});
```

Validation enforces: non-empty splits, bps sum exactly 10000, at most 5
splits, `maxAmount >= 1`, non-empty escrow.

## If you call us via HTTP

The 402 envelope looks like this in v6.16:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "@faremeter/flex",
      "network": "solana",
      "asset":   "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo":   "<unused under flex — splits authoritative>",
      "maxAmountRequired": "10000",
      "resource": "/v1/skills/skill_id/execute",
      "description": "Flex-metered execute",
      "extra": {
        "flexAuthorizationDraft": {
          "escrow":          "<agent-escrow-pda>",
          "mint":            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "maxAmount":       "10000",
          "authorizationId": "...",
          "expiresAtSlot":   "...",
          "splits": [
            { "recipient": "<platform-usdc-ata>",    "bps": 1000 },
            { "recipient": "<contributor-usdc-ata>", "bps": 9000 }
          ]
        },
        "programId": "<flex-program-address>"
      }
    }
  ]
}
```

To pay, the client:

1. Takes `accepts[0].extra.flexAuthorizationDraft` as the authorization to
   sign.
2. Serializes it via `serializePaymentAuthorization` from
   `@faremeter/flex-solana` (or the SDK helper if you're using
   `@unbrowse/sdk`).
3. Signs the serialized bytes with the **session key** registered against
   the draft's `escrow`. The signature is 64 bytes, Ed25519.
4. Packs the result as a `FlexPaymentPayload`:
   ```ts
   {
     scheme:  "@faremeter/flex",
     network: "solana",
     payload: { /* the FlexPaymentPayload wire shape */ }
   }
   ```
5. Base64-encodes the JSON envelope and sets it as the `X-PAYMENT` request
   header on the retry.

The backend's facilitator (`flex-facilitator.ts`) verifies the signature,
holds against the escrow, dispatches the route, settles the actual amount
(or `maxAmount` for non-metered routes), and schedules the on-chain flush.

## Onboarding requirements

Net new in v6.16: every agent must complete three onboarding steps before
the first paid call settles:

1. **Pair a wallet** — Solana mainnet signer. lobster.cash recommended.
2. **Fund a Flex escrow** — prepaid USDC reserve, scoped to your wallet +
   the Unbrowse facilitator.
3. **Register a session key** — Ed25519 keypair that signs authorizations
   on the hot path.

Agents that registered under v6.15 (wallet-only) get a one-time soft block
on their next priced call:

```
HTTP/1.1 402 Payment Required
X-Flex-Onboarding-Required: 1

{
  "error": "flex_onboarding_required",
  "missing": ["flex_escrow_address", "flex_session_key_address"],
  "remediation": "Run `unbrowse setup` or pair via /account"
}
```

Free routes (health, public search) keep working. Sponsor mode keeps
covering brand-new agents who haven't completed onboarding, subject to the
$1/day per-agent and $50/day global caps.

See [`docs/wallets.md`](./wallets.md) for the wallet + escrow + session-key
setup walkthrough.

## Env vars and config

Removed:
- `CORBITS_FACILITATOR_URL` (Corbits facilitator address; gone)
- `CASCADE_PLATFORM_WALLET` (Cascade split platform recipient; gone)
- `CASCADE_SIGNER_SECRET_KEY` (Cascade signer; gone)
- `@cascade-fyi/splits-sdk` dependency in `backend/package.json` (gone)

Kept (rebound):
- `CASCADE_RPC_URL`, `CASCADE_RPC_WS_URL` — repurposed as the Solana RPC the
  Flex facilitator + SDK call out to. Rename to `SOLANA_RPC_URL` /
  `SOLANA_RPC_WS_URL` is deferred to v6.17.

Added:
- `FLEX_PLATFORM_FACILITATOR_KEY` (secret) — the platform facilitator's
  signer secret.
- `FLEX_PLATFORM_RECIPIENT_USDC_ATA` — the platform's USDC associated token
  account; this is where `PLATFORM_BPS = 1000` (10%) lands on every split.
- `FLEX_REFUND_TIMEOUT_SLOTS` — how long an authorization is held before
  refund eligibility (≈150 = 1 minute by default).
- `FLEX_DEADMAN_TIMEOUT_SLOTS` — Flex deadman switch for unilateral escrow
  recovery if the facilitator becomes unresponsive.
- `FLEX_SPONSOR_ESCROW_ADDRESS` — the platform's sponsor escrow PDA (used
  only when `SPONSOR_USE_FLEX_SPLIT=1`).
- `FLEX_SPONSOR_SESSION_KEY_SECRET` (secret) — short-expiry Ed25519 session
  key registered against the sponsor escrow.
- `SPONSOR_USE_FLEX_SPLIT` — `0`/`1` gate. Defaults off in
  v6.16-preview.0 to preserve the v6.15 sponsor narrative during cold start.

## Where to look in source

| What | File |
|---|---|
| Splits arithmetic | `backend/src/services/flex.ts:49 — computeFlexSplits` |
| Authorization assembly | `backend/src/services/flex.ts:98 — buildFlexAuthorization` |
| Facilitator handler | `backend/src/services/flex-facilitator.ts:133 — createFlexFacilitator` |
| Payment-terms glue | `backend/src/services/flex-payment-terms.ts` |
| Sponsor on Flex | `backend/src/services/sponsor-flex.ts:151 — sendSponsorFlexPayment` |
| Onboarding gate | `backend/src/middleware/flex-onboarding-required.ts`, `backend/src/middleware/flex-onboarding-soft-block.ts` |
| SDK retry helper | `packages/sdk/src/flex.ts:200 — payAndRetryFlex` |
| SDK build authorization | `packages/sdk/src/flex.ts:162 — buildFlexAuthorization` |
| SDK escrow + session key | `packages/sdk/src/flex.ts:411 — fundEscrow`, `packages/sdk/src/flex.ts:437 — registerSessionKey` |
| SDK metered execute | `packages/sdk/src/client.ts:447 — Unbrowse#executeMetered` |

## FAQ

**My v6.15 client sends `X-PAYMENT` with an `exact` payload. What
happens?**
The backend's facilitator rejects the verify step (scheme mismatch); the
client sees a fresh `402` whose `accepts[0].scheme === "@faremeter/flex"`.
Upgrade your retry path to use `payAndRetryFlex` or the SDK's
`executeMetered`.

**Do I need to refund my Cascade splits before upgrading?**
No. The platform ran a one-time migration
(`backend/scripts/cascade-final-distribute.ts`) that flushed every Cascade
vault with non-zero balance to its creators before the dependency was
removed. Historical USDC is final.

**My escrow refund window is too long. Can I make `finalize` faster?**
`FLEX_REFUND_TIMEOUT_SLOTS` is platform-controlled (default ~150 slots ≈
1 minute). Shorter windows reduce dispute time; longer windows give more
recovery margin. The platform tuning trades creator-latency vs
chargeback-safety; talk to us if you have a use case for a non-default
window.

**Can I use Flex on EVM?**
Not yet. Flex is Solana-only as of Faremeter's current release. EVM
support is on Faremeter's roadmap. Unbrowse paid routes stay Solana-only
for v6.16.
