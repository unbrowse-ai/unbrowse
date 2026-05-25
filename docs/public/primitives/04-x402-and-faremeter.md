# x402 and Faremeter

## The rule

Paid endpoints in Unbrowse's marketplace are gated by HTTP 402. The wire protocol is x402. The settlement layer is Faremeter. Payment providers are pluggable above the Faremeter boundary.

The agent calling Unbrowse never has to negotiate payment manually. It calls the endpoint, the server returns 402 with an `accepts` envelope, the client signs (or auto-pays via subscription), the request retries with payment, the server returns the resource.

## Layer separation

| Layer | What it does | Who can swap |
|---|---|---|
| Application | The endpoint that needs paying for (an indexed route, a captured skill, a marketplace publish) | Unbrowse code |
| Wire | x402 negotiation: 402 with `accepts`, retry with `X-PAYMENT` or `PAYMENT-SIGNATURE` | The standard; we conform |
| Scheme | The settlement model. Today: `exact` (per-request) and `@faremeter/flex` (escrow + session key + variable settle). | Per-endpoint at server declare |
| Settlement | The chain (Solana for Flex today, EVM planned) | Faremeter |
| Payment source | Where the funds actually came from: the user's own wallet, a sponsor tier, a third-party provider | Pluggable above Faremeter |

The agent only sees the application call. The wire, the scheme, the settlement, and the source are transparent.

## Flex (variable-cost endpoints)

For endpoints where the cost is not known up front (an agent that streams variable tokens, a capture that runs for variable time, a search that returns variable rows), the `@faremeter/flex` scheme uses prepaid escrow plus off-chain session-key authorization.

The mechanics, in one paragraph: the user funds an escrow account once. They register a session key on chain. The middleware signs an authorization with the session key when work starts; the facilitator verifies the signature and holds the maximum amount in memory; the middleware reports the actual amount when work finishes; the facilitator settles the actual amount on chain in a batch, and any extra is released back to the user.

The refund window lets the operator cancel or reduce a settlement during a configurable timeout. The deadman switch lets the user unilaterally recover funds if the facilitator becomes unresponsive.

Concrete handler shape we use:

```typescript
createUptoHandler({
  facilitatorURL,
  accepts: [{ scheme: "@faremeter/flex", network: "solana-devnet", amount: "<ceiling>", asset: "USDC", payTo: "<merchant-token-account>" }],
  authorize: async (body) => BigInt(estimateCeiling(body)),
  handle: async (body, settle) => {
    const result = await doWork(body);
    await settle(BigInt(actualCost(result)));
    return new Response(JSON.stringify(result));
  },
});
```

## Provider plurality

The application calls the endpoint. The 402 response carries `accepts`. The accepted schemes can be any combination of:

- `exact` over USDC on Solana (Unbrowse's wallet, the default)
- `@faremeter/flex` over USDC on Solana (Unbrowse's wallet, for variable-cost endpoints)
- A third-party provider's scheme (`pay` signer, `agentcash.dev`, or any other x402-compliant facilitator)
- The site's own payment endpoint (if the site already speaks x402, the marketplace publish references it)

The cut Unbrowse takes is at the Faremeter facilitator layer, on `@faremeter/flex` settlements with a `defaultSplits` recipient set we control. When the user pays through a third-party scheme or the site's own endpoint, we do not see the payment and we do not take a cut. The provider boundary is the boundary.

## Sponsor tier (paid by us, transparent to the agent)

The first $1/day per agent and the first $50/day per platform are sponsored by Unbrowse's wallet. The agent's request fires a 402, the sponsor middleware checks the per-day cap, and if room remains it pays from the sponsor wallet and the agent never sees the 402. When the cap trips, the 402 propagates to the agent's own x402 client.

State for sponsor accounting:

- `sponsor:agent:<id>:<UTC-date>` — per-agent daily spend
- `sponsor:global:<UTC-date>` — global daily spend
- `sponsor:ledger:<id>` — append-only ledger of sponsor payments per agent

Surface for the agent and Lewis:

- `GET /v1/account/sponsor-status` — per-agent caps and consumption
- `GET /v1/admin/sponsor-ledger` — ADMIN_KEY-gated global view

## What this rules out

- Application code reaching into the payment scheme to inspect signatures, holds, or chains.
- Per-endpoint provider hardcoding ("this endpoint always uses one named pay signer"). Provider plurality is at the 402 `accepts` boundary, not in the application code.
- The marketplace taking a cut on payments routed through a non-Faremeter provider. The cut is layered with the settlement.
- Refunds going through application code. Refund is a Faremeter-layer surface (the refund window on Flex, the dispute window on exact).
