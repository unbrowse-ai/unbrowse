# Example: Data Extraction Worker

Classic use case: turn a list of URLs plus intents into structured data.

```ts
import { Unbrowse } from "@unbrowse/sdk";
import { writeFile } from "node:fs/promises";

const u = new Unbrowse({ timeoutMs: 30_000 });

const targets = [
  { intent: "product details", url: "https://example-shop.com/p/123" },
  { intent: "product details", url: "https://example-shop.com/p/124" },
  { intent: "product details", url: "https://example-shop.com/p/125" },
];

const rows: unknown[] = [];
for (const t of targets) {
  const resolved = await u.resolve(t);
  const pick = resolved.available_endpoints?.[0];
  if (!pick) {
    rows.push({ url: t.url, error: "resolve_miss", next_action: resolved.next_actions?.[0]?.command });
    continue;
  }

  const r = await u.execute(pick.endpoint_id, {
    params: Unbrowse.paramsFromInputSpec(pick.input_params),
    contextUrl: t.url,
  });

  rows.push({
    url: t.url,
    data: r.result,
    success: r.trace.success,
    status_code: r.trace.status_code,
  });

  await u.feedback({
    skillId: resolved.skill?.skill_id ?? "",
    endpointId: pick.endpoint_id,
    rating: r.trace.success ? 1 : 0,
    outcome: r.trace.success ? "success" : "failure",
  });
}

await writeFile("out.json", JSON.stringify(rows, null, 2));
```

## Why this is fast on iteration N

The first URL on a new domain triggers a full live capture. The runtime publishes the captured skill. URLs 2..N hit the cache. By target #3 you should be on a sub-second-per-call path.

If target #2 still triggers capture, the published skill probably failed admission. Inspect with `await u.getSkill(resolved.skill?.skill_id ?? "")` to see the manifest, or run `unbrowse skills` locally to list known skills.

## Productionizing

- Cap concurrency at 8 per runtime.
- Batch by domain so the cache warms quickly.
- Persist `pick.endpoint_id` if you'll re-extract. Direct `execute(endpoint_id)` skips the resolve round-trip entirely.
