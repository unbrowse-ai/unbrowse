# Stripe x402 bridge

## The rule

Sellers can accept x402 payments through Stripe and never touch a USDC wallet. Buyers can pay an x402 invoice through Stripe Link Agents with a regular card and never hold USDC themselves. The x402 protocol stays the wire format; Stripe is the fiat/crypto bridge at both ends.

The user-facing claim: x402 disappears as a thing to learn or configure. People use Stripe.

## Why this matters

x402 is the right protocol for machine-to-machine settlement, but the wallet and on-chain UX is the friction. Two groups feel this:

1. **Sellers** who want paid endpoints but don't want to custody USDC, run a wallet, or reconcile on-chain transfers. They want a Stripe Dashboard row, not a Solana explorer link.
2. **Buyers** (humans driving agents) who want to authorize spend without holding stablecoins or signing transactions. They want the same card flow they use everywhere else.

Stripe shipped both bridges in 2026. The seller bridge is in production at `docs.stripe.com/payments/machine/x402`. The buyer bridge is Link Agents, in preview as of April 29 2026.

## Seller-side bridge (Stripe captures USDC, settles fiat)

The seller asks Stripe to issue a one-time deposit address per request. The 402 response carries the address as `payTo`. The buyer settles USDC to it. Stripe watches the chain, captures the PaymentIntent on confirmation, and credits the seller's Stripe account in their currency of choice. The seller's code never imports a wallet library.

Minimal Node integration:

```typescript
import Stripe from "stripe";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-03-04.preview",
});

async function createPayToAddress(ctx: { paymentHeader?: string }) {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: 1000,                              // $0.01 in cents
    currency: "usd",
    payment_method_types: ["crypto"],
    payment_method_data: { type: "crypto" },
    payment_method_options: {
      crypto: {
        mode: "deposit",
        deposit_options: { networks: ["base"] },
      },
    },
    confirm: true,
  });
  return paymentIntent.next_action!.crypto_display_details!
    .deposit_addresses["base"].address;
}

app.use(paymentMiddleware(
  {
    "GET /paid": {
      accepts: [{
        scheme: "exact",
        price: "$0.01",
        network: "eip155:8453",
        payTo: createPayToAddress,
      }],
      mimeType: "application/json",
    },
  },
  new x402ResourceServer(new HTTPFacilitatorClient("https://facilitator.x402.rs/"))
    .register("eip155:8453", new ExactEvmScheme()),
));
```

The seller's Stripe Dashboard shows the payment as a normal PaymentIntent in USD. No wallet, no on-chain reconciliation, no key custody.

Supported deposit networks per the Stripe docs: Base, Solana, Tempo. USDC is the only supported token.

## Buyer-side bridge (Stripe Link Agents card → USDC behind the scenes)

A non-crypto user wants their agent to call a paid endpoint. The agent gets a 402 with payment requirements. Instead of signing a USDC transfer with a wallet the user doesn't have, the agent calls Stripe Link Agents:

1. The Link wallet shows the user a real-time approval prompt (mobile push or web modal): "Authorize $0.01 to facilitator.x402.rs?"
2. User taps approve.
3. Stripe issues a Shared Payment Token (SPT) scoped to that single facilitator and amount.
4. Stripe charges the user's saved card, converts to USDC at the spot rate, settles to the facilitator on Base, and returns the EIP-3009 signed payload to the agent.
5. The agent puts the payload in `PAYMENT-SIGNATURE` and retries the request. The server (or its facilitator) verifies, serves the resource.

The user never sees `0x...`. Their statement says "Stripe Link Agent — $0.01" same as any other Stripe charge. The agent never holds USDC. The facilitator never knows the buyer used a card.

## Composition with the rest of the stack

| Layer | What handles it | Doctrine |
|---|---|---|
| The protocol | x402 itself (HTTP 402 + payment-required header) | x402 Foundation spec |
| Seller fiat bridge | Stripe PaymentIntent with `payment_method_types: ["crypto"]` | this primitive |
| Buyer card bridge | Stripe Link Agents (SPT issuance) | this primitive |
| Facilitator (settles USDC on-chain) | x402.rs / Coinbase CDP / PayAI / etc. — operator-pluggable | [13-x402-facilitator-choice](./13-x402-facilitator-choice.md) |
| Multi-recipient revenue split | Cascade Splits (the `payTo` becomes the splitter contract) | [07-fair-split-and-claim](./07-fair-split-and-claim.md) |

The Stripe bridge does not replace the facilitator — it composes with it. Stripe creates the deposit address; the facilitator settles the USDC transfer to that address; Stripe captures the PaymentIntent when the on-chain settlement confirms.

For seller revenue splits via Cascade: the `createPayToAddress` returns the Cascade splitter contract address (not a single Stripe address), and Stripe captures the seller's share as the PaymentIntent. The splitter handles the indexer + domain-owner shares natively; Stripe only sees the seller's slice.

## What this rules out

- A separate Stripe-vs-x402 decision for sellers. Sellers can stay on Stripe and still accept agent payments — they just point `payTo` at a Stripe deposit address.
- Onboarding friction for human buyers. Anyone with a Stripe Link account can fund an agent without learning what a wallet is.
- Custody surface for either party. Stripe holds the card-to-USDC bridge; the facilitator does the on-chain settle; the seller account holds the fiat. Unbrowse holds none of these.
- Lock-in. The protocol stays x402; the facilitator stays operator-pluggable per primitive 13. Stripe is one bridge, not the only one.

## What requires Stripe API access

| Operation | Requires |
|---|---|
| Seller-side `payTo` address creation | Stripe secret key + API version `2026-03-04.preview` |
| Buyer-side card pay | Buyer has a Stripe Link account; agent calls Link Agents SDK |
| Facilitator settlement | Independent of Stripe — uses whichever facilitator the 402 response names |

Stripe's pricing for the x402 path tracks their normal crypto-on-ramp pricing (currently 1.5% with a $0.30 minimum on each USD-to-USDC conversion at the buyer side). Seller-side capture has no extra Stripe fee beyond their standard PaymentIntent pricing.

## When NOT to bridge through Stripe

| Reason | Use this instead |
|---|---|
| You're a USDC-native agent and want zero fiat hop | Direct to facilitator per [primitive 13](./13-x402-facilitator-choice.md); no Stripe involved on either end |
| You need sub-cent micropayments (Stripe minimum is $0.01) | Bypass Stripe on the seller side; use a Cascade splitter that settles natively |
| You need a non-USDC asset on settlement | Stripe only supports USDC; for other assets use a native facilitator |
| You're regulated for "no crypto at all" on the seller side | Stripe's crypto-payment-method is still a crypto rail by Stripe's classification, even though the seller sees fiat. Confirm with compliance. |
