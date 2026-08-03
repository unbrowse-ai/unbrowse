# Onboarding: Swarms as Validators

For clients running a fleet of agents (10+ workers) that should contribute to the Unbrowse marketplace as **validators** and earn x402 rewards.

> A *validator* in Unbrowse is any agent that runs real intents through resolve/execute, generates traffic that becomes captured skills, and gets attribution on every later replay of those skills. Validators are paid in proportion to how often their captured routes are reused.
>
> **Term note:** the [whitepaper](../whitepaper/network-layer.md) reserves "validator" for a future verification/staking role. Until that layer ships, "validator" in product docs means "earning agent in the contributor pool." If the whitepaper sense matters in your context, prefer "contributor" or "earning agent."

## Mental model

```
Client agent fleet  --->  Local Unbrowse runtime  --->  Marketplace
(Claude/Codex/etc.)       (one per worker box)         (publish + pay)
        |                          |                          |
        | resolve(intent, url)     | capture + index          | x402 settle
        v                          v                          v
   real work                  routes published          wallet credited
```

## Prerequisites

- A Solana wallet that can receive USDC. We recommend [Crossmint Lobster](https://lobster.cash) for fleet-level payouts (it supports headless agents).
- Per-worker isolation: each agent runs against its own local Unbrowse runtime so captures are not cross-contaminated.
- A registered agent account so payouts attribute to your org.

## Step 1 — Provision the operator wallet

```bash
npx @crossmint/lobster-cli setup
# captures wallet address into ~/.lobster/agents.json; unbrowse setup picks it up automatically.
```

Or set the env var directly:

```bash
export AGENT_WALLET_ADDRESS="<solana address>"
# or, equivalently, LOBSTER_WALLET_ADDRESS
```

Wallet resolution order at runtime (verified in `src/payments/wallet.ts:getWalletContext`): `LOBSTER_WALLET_ADDRESS`, then `AGENT_WALLET_ADDRESS`, then the local Lobster `agents.json`. Whichever wins becomes the address the marketplace credits.

## Step 2 — Boot the runtime per worker

Every worker box runs its own runtime so capture state stays clean.

```bash
npm install -g unbrowse
unbrowse setup
unbrowse account --register --email ops@yourco.com
```

The runtime auto-starts on demand on `http://localhost:6969` when an SDK or CLI call needs it. There's no separate `server start` command — just call resolve and the runtime spins up.

For multi-worker boxes, give each worker its own runtime by setting a distinct port and home dir per process and warming it once:

```bash
UNBROWSE_PORT=6970 UNBROWSE_HOME=/var/unbrowse/worker-1 unbrowse stats >/dev/null
```

Then point that worker's SDK at `http://localhost:6970`.

## Step 3 — Wire the SDK in your agent

```ts
import { Unbrowse } from "unbrowse/sdk";

const unbrowse = new Unbrowse({
  baseUrl: process.env.UNBROWSE_URL ?? "http://localhost:6969",
  apiKey: process.env.UNBROWSE_API_KEY,
  clientId: `worker-${process.env.WORKER_ID}`,
});

async function doTask(intent: string, url: string) {
  const resolved = await unbrowse.resolve({ intent, url });

  const pick = resolved.available_endpoints?.[0];
  if (!pick) {
    // Resolve miss: agent decides whether to follow next_actions or skip.
    return resolved.next_actions?.[0];
  }

  const r = await unbrowse.execute(pick.endpoint_id, {
    contextUrl: url,
    projection: { raw: true },
  });

  return r.trace.success ? r.result : r.trace.error;
}
```

`clientId` is important — it lets the marketplace track which worker captured which skill, so payouts attribute correctly even when several workers race the same domain.

## Step 4 — Confirm earnings flow

Every published skill is re-executable by other Unbrowse users. When that happens, your wallet gets credited.

```bash
unbrowse stats --earnings
unbrowse stats --json
```

From the SDK (typed in 6.9.69423+):

```ts
const me = await unbrowse.dashboard();                          // GET /v1/dashboard/me
const public_view = await unbrowse.dashboardByWallet(addr);     // public, no auth
const { ledger, transactions } = await unbrowse.creatorTransactions(agentId);
const attribution = await unbrowse.indexerAttribution(indexerId);
```

Funds settle on-chain via x402 once the unsettled balance crosses the platform threshold.

## Step 5 — Tune for high-volume validation

For swarms running 100+ resolve/sec across the fleet:

- **Pin one runtime per worker.** A shared runtime serializes capture and tanks throughput.
- **Leave `force_capture` false (default).** Cache hits are free for you and credit the original publisher (often you); that's the system working as intended.
- **Set `confirmThirdPartyTerms: true` only on domains you actually have permission to scrape.** This is a real legal gate, not a flag to flip blindly.
- **Use `feedback()` aggressively.** Every `outcome: "success" | "failure"` improves marketplace ranking and your validator reputation, which lifts payout weighting.
- **Use `unbrowse settings --publish-blacklist <domain>`** to keep sensitive internal domains out of the marketplace.

## Anti-patterns

- Running the same `clientId` on every worker — payout attribution collapses.
- Sharing one runtime across 50 workers — capture races, dropped skills, lost earnings.
- Forcing `force_capture: true` on every call — you'll pay browser-open cost without earning more, since cache-hit earnings already credit the original publisher.
- Pointing at the public OSS repo for a custom build — see [OPEN-SOURCE-NOTICE.md](../OPEN-SOURCE-NOTICE.md). Use the npm CLI binary.

## See also

- [Rewards & economics](./rewards-and-economics.md)
- [Developer recipes](./developer-recipes.md)
- [SDK API reference](../../packages/sdk/docs/api-reference/)
