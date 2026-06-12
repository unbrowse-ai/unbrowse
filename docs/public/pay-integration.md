# `pay` × Unbrowse

[`pay`](https://pay.sh) is the wallet-approved HTTP 402 payment layer for agents.
It works with Unbrowse in **both directions**:

1. **Pay for Unbrowse** — `pay` settles Unbrowse's own paid endpoints (below).
2. **Unbrowse pays for you** — `unbrowse fetch` uses `pay` as a wallet adapter to
   pay *any* 402-gated URL on your behalf ([next section](#unbrowse-as-a-pay-client)).

## Paying for Unbrowse with `pay`

Unbrowse's paid endpoints speak standard **HTTP 402 / x402** (Solana mainnet, USDC).
That makes them directly usable with [`pay`](https://pay.sh) — the wallet-approved
402 payment layer for HTTP agents — with no Unbrowse-specific glue.

## How it works

`pay` wraps a normal command, detects the 402 payment challenge in the response,
asks the local wallet to authorize signing, and retries with a payment proof.
Unbrowse emits a conformant x402 challenge (`PAYMENT-REQUIRED` header + JSON body
with `scheme: exact`, `network: solana`, `asset: <USDC mint>`, `payTo`, `amount`),
so `pay` parses and settles it like any other x402 provider.

## Use it

```sh
# Real payment (funded mainnet wallet; pay prompts for local authorization):
pay curl -X POST https://beta-api.unbrowse.ai/v1/llm/anthropic/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

# Test the wrapping/detection with an ephemeral sandbox wallet (no real funds):
pay --sandbox curl https://payment-debugger.vercel.app/mpp/quote/AAPL
```

`--sandbox` uses a localnet ephemeral wallet, so it proves detection but cannot
settle Unbrowse's mainnet challenge (the server correctly reports it "expects
mainnet"). For a real call, fund a mainnet wallet and drop `--sandbox`; `pay`
settles the USDC payment and retries the request automatically.

## Verify

`bash scripts/pay-unbrowse-gate.sh` exits 0 when `pay` is functional and parses
Unbrowse's x402 challenge — the runnable witness for this integration.

## Unbrowse as a `pay` client

The other direction: point Unbrowse at *any* 402-gated URL and let it pay with
your `pay` wallet. The primary URL tool, `unbrowse fetch <url>`, detects a
`402 Payment Required` response and — when a wallet adapter is configured —
authorizes the payment through `pay` and retries once, returning the paid body.

Because `pay` owns the whole handshake, this covers both **x402** and **MPP**
challenges (the metered-payment-protocol challenges that a plain x402 envelope
parser cannot read).

```sh
# Sandbox (ephemeral localnet wallet — no real funds). Start a demo gateway:
pay --sandbox server demo                      # serves a 402-gated endpoint on :1402

# In another shell — Unbrowse pays the 402 and prints the paid response:
UNBROWSE_WALLET_ADAPTER=pay UNBROWSE_PAY_SANDBOX=1 \
  unbrowse fetch http://127.0.0.1:1402/api/v1/reports/usage
# → [fetch] paid 402 via pay (pay_signed) → 200
#   {"status":"ok"}
```

| Environment variable | Effect |
| --- | --- |
| `UNBROWSE_WALLET_ADAPTER=pay` | Route 402 payments through the `pay` CLI. Default-off; nothing pays unless this is set. |
| `UNBROWSE_PAY_SANDBOX=1` | Pass `--sandbox` to `pay` (ephemeral localnet wallet, no real funds). |
| `UNBROWSE_X402_MAX_COST_USD` | Per-request cost ceiling (default `1.00`). A challenge above the ceiling is refused before any payment. |

For real (mainnet) payments, drop `UNBROWSE_PAY_SANDBOX` and fund your `pay`
wallet — payment still requires local authorization. Without a wallet adapter,
`unbrowse fetch` prints the 402 body and exits non-zero with a `next_step` telling
you what to configure. Non-402 fetches are unaffected.

The same adapter also satisfies any priced Unbrowse route executed through the
client — set `UNBROWSE_WALLET_ADAPTER=pay` and paid `execute` / `resolve` calls
settle through your `pay` wallet alongside the native x402 / Flex path.
