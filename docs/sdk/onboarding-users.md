# Onboarding: Single-User Mining

For an individual developer or operator who wants to use Unbrowse as their agent's browser **and** earn rewards from the routes their normal browsing creates.

## The 60-second path

```bash
npm install -g unbrowse
npx @crossmint/lobster-cli setup    # provision the wallet that will receive earnings
unbrowse setup                       # detects the wallet automatically
unbrowse account --register --email you@example.com
```

That's it. Every later `resolve` / `execute` you run mines the marketplace, credits your wallet, and is free for cache hits.

Next, see [unbrowse/sdk installation](../../packages/sdk/docs/getting-started/installation.md) to wire the SDK into your code.

That's it. Every later `resolve` / `execute` you run mines the marketplace, credits your wallet, and is free for cache hits.

## What "mining" actually means

When you (or your agent) runs:

```bash
unbrowse resolve --intent "top stories" --url https://news.ycombinator.com
```

Unbrowse:

1. Checks the marketplace cache for a matching skill. If found: free, fast, you've consumed.
2. If not, captures network traffic from a headless browser session.
3. Reverse-engineers the captured traffic into a callable skill.
4. Publishes the admitted skill back to the marketplace under your wallet address.

Later, when another agent anywhere runs the same intent against the same domain and the marketplace serves your skill, **you get paid**. Payment is in USDC over x402, settled on Solana.

## Wallet setup

The simplest path:

```bash
npx @crossmint/lobster-cli setup
unbrowse setup    # detects the lobster config automatically
```

Lobster is a self-custodial wallet sized for agent micropayments.

If you already have a wallet:

```bash
export AGENT_WALLET_ADDRESS="<your solana address>"
unbrowse setup
## See your earnings

```bash
unbrowse stats --earnings
unbrowse stats --json
```

For the web dashboard, visit `https://www.unbrowse.ai/dashboard` once your account is paired.

From the SDK:

```ts
import { Unbrowse } from "unbrowse/sdk";
const u = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });
const me = await u.dashboard();
console.log(me.earnings?.total_usd, me.earnings?.unsettled_usd);
```

From the SDK:

```ts
await u.request("GET", "/v1/dashboard/me");
```

## Make your normal agent calls earn

The SDK is the same as the validator path:

```ts
import { Unbrowse } from "unbrowse/sdk";

const u = new Unbrowse();
const result = await u.resolve({
  intent: "my newsletter signups",
  url: "https://app.beehiiv.com/dashboard",
});
```

If your wallet is configured during `unbrowse setup`, every captured skill is auto-published under your address.

## Privacy boundary

- Captured skills are **patterns**, not data. The marketplace stores the request shape (URL template, headers, response schema), not your actual response bodies.
- Auth headers and cookies are stripped before publish.
- You can exclude domains from publish via `unbrowse settings --publish-blacklist <domain>`. Captures from those domains never reach the marketplace.

## When to upgrade to the validator path

If you start running 10+ parallel agents, see [onboarding-validators.md](./onboarding-validators.md). The single-user path serializes captures through one runtime, which becomes the bottleneck above ~5 concurrent resolves.
