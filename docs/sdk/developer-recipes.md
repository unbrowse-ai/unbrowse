# Developer Recipes

Common SDK patterns. The SDK surface is small (`resolve`, `execute`, `login`, `importAuth`, `search`, `searchDomain`, `getSkill`, `feedback`, `stats`, `health`). Most leverage comes from composing them.

## Recipe 1: Resolve, then let the LLM pick the endpoint

The two-tool-call contract: never auto-execute on resolve. Resolve returns a shortlist in `available_endpoints`; the calling LLM picks; execute runs the pick.

```ts
const resolved = await u.resolve({ intent, url });

const pick = await llm.choose({
  intent,
  candidates: resolved.available_endpoints,
});

// Build params from the picked endpoint's declared input shape.
const params: Record<string, unknown> = {};
for (const p of pick.input_params ?? []) {
  if (p.example_value !== undefined) params[p.key] = p.example_value;
}

const r = await u.execute(pick.endpoint_id, {
  params,
  projection: { raw: true },
});
```

This is what makes the SDK feel like a tool the agent reasons over, not a black box.

## Recipe 2: Auth-then-mine on a gated site

```ts
const login = await u.login({ url: "https://linkedin.com" });

const resolved = await u.resolve({
  intent: "my recent messages",
  url: "https://www.linkedin.com/messaging/",
});
```

For headless workers, use cookie import from a real Chrome/Firefox profile:

```ts
await u.importAuth({
  url: "https://linkedin.com",
  browser: "chrome",
  chromeProfile: "Default",
});
```

## Recipe 3: Domain search before resolve

When you know the domain but not the intent fit, search first to avoid an unnecessary live capture.

```ts
const hits = await u.searchDomain({
  domain: "news.ycombinator.com",
  intent: "new submissions",
  k: 5,
});

const hit = hits.results?.[0];
if (hit?.skill_id) {
  return await u.execute(hit.skill_id, { params: {} });
}
return await u.resolve({ intent: "new submissions", url: "https://news.ycombinator.com/newest" });
```ts
const r = await u.execute(pick.endpoint_id, { params });

await u.feedback({
  skillId: resolved.skill?.skill_id ?? "",
  endpointId: pick.endpoint_id,
  rating: r.trace.success ? 5 : 1,
  outcome: r.trace.success ? "success" : "failure",
  diagnostics: r.trace.success ? undefined : { wrong_endpoint: true },
});
```
  endpointId: pick.endpoint_id,
  outcome: r.trace.success ? "success" : "failure",
  rating: r.trace.success ? 5 : 1,
  diagnostics: r.trace.success ? undefined : { error: r.trace.error },
});
```

## Recipe 5: Long-running worker pool

```ts
import { Unbrowse } from "@unbrowse/sdk";
import pLimit from "p-limit";

const u = new Unbrowse({ clientId: `worker-${process.pid}` });
const limit = pLimit(8);

async function processBatch(tasks: { intent: string; url: string }[]) {
  return Promise.all(tasks.map(t => limit(async () => {
    try {
      const resolved = await u.resolve(t, { timeoutMs: 15_000 });
      const pick = resolved.available_endpoints?.[0];
      if (!pick) return { task: t, status: "miss" };
      const r = await u.execute(pick.endpoint_id);
      return { task: t, status: r.trace.success ? "ok" : "fail", data: r.result };
    } catch (e) {
      return { task: t, status: "error", error: String(e) };
    }
  })));
}
```

Key constraint: 8 concurrent against one runtime is roughly the safe ceiling. For more, run multiple runtimes (see [onboarding-validators.md](./onboarding-validators.md)).

## Recipe 6: Custom fetch / proxy

Useful for routing through a residential proxy or for instrumentation.

```ts
import { Unbrowse } from "@unbrowse/sdk";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const dispatcher = new ProxyAgent("http://geo.iproyal.com:12321");
const u = new Unbrowse({
  fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }),
});
```

## Recipe 7: Health-gated startup

```ts
async function waitForRuntime(u: Unbrowse, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await u.health({ timeoutMs: 1000 });
      if (h.status === "ok") return h;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("unbrowse runtime did not become healthy");
}
```

## Recipe 8: Decide between SDK and CLI

| Need | Use |
|---|---|
| In-process agent making many calls | SDK |
| One-off shell automation | CLI |
| Auth flow with user-facing browser | CLI (`unbrowse login`) |
| Earnings / payout queries | CLI (`unbrowse stats --earnings`) or HTTP (`/v1/dashboard/me`, `/v1/transactions/creator/:agentId`) |
| Wallet config | `unbrowse setup` (interactive) or `LOBSTER_WALLET_ADDRESS` / `AGENT_WALLET_ADDRESS` env vars |
| Embedding in MCP / OpenClaw | OpenClaw plugin (auto-routes) |
