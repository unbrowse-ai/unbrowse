# Payments — Sponsor Mode

## What sponsor mode is

The Unbrowse platform pays creator wallets in USDC on behalf of agents that have not paired a wallet yet — up to **$1 per agent per day**, capped at **$50 across the whole platform per day**. The flywheel needs liquidity before users have a wallet; the platform fronts it.

When sponsor mode covers your call, the response is a normal `200 OK` with the resource body. Two extra headers tell you what happened:

| Header | Meaning |
|---|---|
| `X-Sponsored: <ledger_id>` | The platform settled this call. The ID is the row in the sponsor ledger. |
| `X-Sponsor-Remaining-Usd: <number>` | Sponsor credit left for this agent today (USD, decimal). |

Your code does not change. The headers are informational.

## When you are sponsored

Nothing to do. You call `execute` like normal:

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = await Unbrowse.local({ apiKey: process.env.UNBROWSE_API_KEY });
const result = await u.execute("skill_paid_demo", { params: { ticker: "NVDA" } });
console.log(result);
```

If you want to *see* the sponsor headers, wrap `fetch`:

```ts
const u = await Unbrowse.local({
  apiKey: process.env.UNBROWSE_API_KEY,
  fetch: async (url, init) => {
    const res = await fetch(url, init);
    const ledgerId = res.headers.get("X-Sponsored");
    if (ledgerId) {
      console.log(
        "sponsored ledger=", ledgerId,
        "remaining=$", res.headers.get("X-Sponsor-Remaining-Usd"),
      );
    }
    return res;
  },
});
```

## When sponsor mode is exhausted

When your daily agent cap, the global platform cap, or "no sponsor wallet configured" hits, the gateway returns the standard 402 with the regular `accepts[]` body **plus** these extra headers:

| Header | Meaning |
|---|---|
| `X-Sponsor-Exhausted: 1` | This 402 fired because the sponsor would have covered it but cannot. |
| `X-Sponsor-Reason: agent_cap \| global_cap \| no_wallet` | Why the sponsor declined. |

The SDK throws `SponsorExhaustedError` (subclass of `PaymentRequiredError`) so you can branch:

```ts
import {
  Unbrowse,
  SponsorExhaustedError,
  PaymentRequiredError,
  payAndRetry,
} from "@unbrowse/sdk";

const u = await Unbrowse.local({ apiKey: process.env.UNBROWSE_API_KEY });

async function call() {
  try {
    return await u.execute("skill_paid_demo", { params: { ticker: "NVDA" } });
  } catch (err) {
    if (err instanceof SponsorExhaustedError) {
      console.log(
        "sponsor exhausted:", err.reason,
        "remaining=$", err.remainingCreditUsd,
      );
      const wallet = await loadWallet();
      return payAndRetry(err, wallet, (header) =>
        u.execute(
          "skill_paid_demo",
          { params: { ticker: "NVDA" } },
          { headers: { "X-PAYMENT": header } },
        ),
      );
    }
    if (err instanceof PaymentRequiredError) {
      // Skill is paid AND the agent isn't in sponsor mode at all.
      // Same recovery as above.
      throw err;
    }
    throw err;
  }
}

const result = await call();
```

`reason` discriminates the three exhaustion paths:

- `agent_cap` — this agent already spent $1 today; resets at midnight UTC.
- `global_cap` — the platform-wide $50/day pool is drained; resets at midnight UTC.
- `no_wallet` — the platform sponsor wallet is unconfigured/unfunded. Pair your own wallet.

## Opt out of sponsor mode

For testing the unsponsored flow (or to keep sponsor credit unspent for later), send `X-No-Sponsor: 1`:

```ts
const result = await u.execute(
  "skill_paid_demo",
  { params: { ticker: "NVDA" } },
  { headers: { "X-No-Sponsor": "1" } },
);
```

The backend will route straight to the wallet flow (and 402 if no `X-PAYMENT` is attached).

## Check remaining sponsor credit

The MCP server exposes a `sponsor_status` field on the `unbrowse_settings` tool — see the [MCP docs](../../README.md) for the call. Programmatically from the SDK, the per-response `X-Sponsor-Remaining-Usd` header is the authoritative number; the SDK does not (yet) expose a dedicated `getSponsorStatus()` method. Roll your own with the `fetch` wrapper shown above, or read the dashboard:

```ts
const dash = await u.dashboard();
// dash.spending and dash.contributions carry the recent settlement entries.
```

## Why we sponsor

The marketplace fills itself only when callers actually call. If every new agent has to fund a wallet before their first paid skill, most never make it past install. Sponsor mode buys creators their first cohort of paying calls so the supply side has revenue to point at.

See [`docs/x402-flywheel.md`](../../../../docs/x402-flywheel.md) for the macro narrative — how sponsored calls today fund creator earnings tomorrow fund agent retention next quarter.
