# Developer Recipes

Common SDK patterns. The current SDK surface is the hole: `createHole().fill(...)`.
The older `resolve`/`execute` methods remain for route inspection and compatibility.

## Recipe 1: Fill One Hole

```bash
unbrowse get "top stories with point counts"
unbrowse get "top stories with point counts" --url "https://news.ycombinator.com"
```

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole({
  client: { apiKey: process.env.UNBROWSE_API_KEY },
});

const r = await hole.fill({
  intent: "top stories on Hacker News with point counts",
  url: "https://news.ycombinator.com",
});
```

This is the agent-facing contract. Internally the runtime may resolve, execute,
open a browser, inspect HAR, reuse cookies, or index a newly discovered route.

## Recipe 2: Inspect a Route Manually

Use the legacy route view only when you need to debug endpoint selection:

```ts
const resolved = await u.resolve({ intent, url });
const pick = resolved.available_endpoints?.[0];
if (!pick) throw new Error("no route");

const r = await u.execute(pick.endpoint_id, {
  projection: { raw: true },
});
```

## Recipe 3: Auth Before a Fill

```ts
await u.login({ url: "https://linkedin.com" });

const r = await hole.fill({
  intent: "my recent messages",
  url: "https://www.linkedin.com/messaging/",
});
```

For headless workers, import cookies from a real Chrome/Firefox profile:

```ts
await u.importAuth({
  url: "https://linkedin.com",
  browser: "chrome",
  chromeProfile: "Default",
});
```

## Recipe 4: Long-running Worker Pool

```ts
import { createHole } from "unbrowse/sdk";
import pLimit from "p-limit";

const hole = createHole({ client: { clientId: `worker-${process.pid}` } });
const limit = pLimit(8);

async function processBatch(tasks: { intent: string; url: string }[]) {
  return Promise.all(tasks.map(t => limit(async () => {
    try {
      const r = await hole.fill(t);
      return { task: t, status: r.ok ? "ok" : "fail", data: r };
    } catch (e) {
      return { task: t, status: "error", error: String(e) };
    }
  })));
}
```

Key constraint: 8 concurrent calls against one runtime is roughly the safe ceiling.
For more, run multiple runtimes.

## Recipe 5: Custom Fetch / Proxy

Useful for routing through a residential proxy or for instrumentation.

```ts
import { createHole } from "unbrowse/sdk";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const dispatcher = new ProxyAgent("http://geo.iproyal.com:12321");
const hole = createHole({
  client: {
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }),
  },
});
```

## Recipe 6: Decide Between SDK and CLI

| Need | Use |
|---|---|
| In-process agent making many calls | SDK `createHole().fill(...)` |
| One-off shell automation | CLI `unbrowse get "task" [--url <url>]` |
| Inspect current contract | `unbrowse contract surface` |
| Auth flow with user-facing browser | CLI (`unbrowse auth`) |
| Route-selection debugging | Legacy `resolve`/`execute` |
| Wallet config | `unbrowse setup` |
