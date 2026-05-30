# Example: Swarm Validator

A Node worker pool that runs intents continuously, captures the misses, and earns from cache hits.

## Layout

```
swarm/
  index.ts        # spawns workers
  worker.ts       # one Unbrowse client per worker
  tasks.json      # {intent, url}[] queue
```

## `worker.ts`

```ts
import { Unbrowse, UnbrowseApiError } from "@unbrowse/sdk";
import pLimit from "p-limit";
import tasks from "./tasks.json";

const u = new Unbrowse({
  baseUrl: process.env.UNBROWSE_URL,
  apiKey: process.env.UNBROWSE_API_KEY,
  clientId: `worker-${process.env.WORKER_ID}`,
  timeoutMs: 20_000,
});

const limit = pLimit(8);

async function run(task: { intent: string; url: string }) {
  try {
    const resolved = await u.resolve(task);
    const pick = resolved.available_endpoints?.[0];
    if (!pick) {
      return { task, status: "miss", next: resolved.next_actions?.[0]?.command };
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
    return { task, status: r.trace.success ? "ok" : "fail" };
  } catch (e) {
    if (e instanceof UnbrowseApiError) return { task, status: "error", code: e.status };
    return { task, status: "error", error: String(e) };
  }
}

async function loop() {
  while (true) {
    const batch = tasks.slice().sort(() => Math.random() - 0.5).slice(0, 64);
    const results = await Promise.all(batch.map(t => limit(() => run(t))));
    console.log(JSON.stringify({ ts: Date.now(), results }));
    await new Promise(r => setTimeout(r, 5000));
  }
}

loop();
```

## `index.ts`

```ts
import { fork } from "node:child_process";
import { cpus } from "node:os";

const N = Math.min(cpus().length, 8);
for (let i = 0; i < N; i++) {
  fork("./worker.ts", [], {
    env: { ...process.env, WORKER_ID: String(i) },
  });
}
```

## Run

```bash
UNBROWSE_API_KEY=... node --import=tsx swarm/index.ts
```

## Earnings check

From the SDK in a sidecar process:

```ts
import { Unbrowse } from "@unbrowse/sdk";
const u = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });

setInterval(async () => {
  const me = await u.dashboard();
  console.log({
    total_usd: me.earnings?.total_usd,
    unsettled_usd: me.earnings?.unsettled_usd,
    routes_active: me.contributions?.routes_active,
  });
}, 60_000);
```

## Tuning

- Each worker holds its own SDK instance. Multiple workers can share one runtime up to a few dozen RPS. Past that, run multiple runtimes (one per box, distinct `UNBROWSE_PORT` and `UNBROWSE_HOME`) and point each worker pool at its own.
- Set `clientId` per worker for clean payout attribution.
- Drop the queue size if you see runtime CPU steady > 80%.
