# Your First Validator

Minimal end-to-end: an agent that runs intents, contributes captures to the marketplace, and earns rewards.

## Pre-flight

```bash
npm install -g unbrowse @unbrowse/sdk
unbrowse setup
npx @crossmint/lobster-cli setup
```

The runtime auto-starts on demand on the first SDK call.

## The script

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = new Unbrowse({
  clientId: `validator-${process.pid}`,
});

const tasks = [
  { intent: "top stories", url: "https://news.ycombinator.com" },
  { intent: "trending repos this week", url: "https://github.com/trending" },
  { intent: "new arxiv ai papers", url: "https://arxiv.org/list/cs.AI/new" },
];

for (const task of tasks) {
  const resolved = await u.resolve(task);

  const pick = resolved.available_endpoints?.[0];
  if (!pick) {
    const handoff = resolved.next_actions?.[0];
    console.log(`miss: ${task.intent}`, handoff?.command ?? "no handoff");
    continue;
  }

  const r = await u.execute(pick.endpoint_id, {
    params: Unbrowse.paramsFromInputSpec(pick.input_params),
    projection: { raw: true },
    contextUrl: task.url,
  });

  await u.feedback({
    skillId: resolved.skill?.skill_id ?? "",
    endpointId: pick.endpoint_id,
    rating: r.trace.success ? 1 : 0,
    outcome: r.trace.success ? "success" : "failure",
  });

  console.log(task.intent, r.trace.success ? "ok" : "fail");
}
```

## What just happened

1. Resolve looked at marketplace cache plus your local skill cache.
2. On miss, the runtime opened a headless browser, captured traffic, reverse-engineered routes.
3. The admitted skills were published to the marketplace under your wallet.
4. Future agents asking the same question against the same domain will hit your published skill, and you'll be credited.

## Confirm earnings

From the SDK:

```ts
const me = await u.dashboard();
console.log(me.earnings?.total_usd, me.earnings?.unsettled_usd);
```

Or from the CLI:

```bash
unbrowse stats --earnings
```

Expect zero on day one. Payouts accumulate as other agents replay your skills.

## Next

- [Swarm validator example](../examples/swarm-validator.md): scale this from one process to a fleet.
- [Earnings reference](../api-reference/rewards.md)
- [Rewards & economics](../../../../docs/sdk/rewards-and-economics.md)
