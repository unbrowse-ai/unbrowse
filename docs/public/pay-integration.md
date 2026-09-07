# Paying for Unbrowse with `pay`

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
