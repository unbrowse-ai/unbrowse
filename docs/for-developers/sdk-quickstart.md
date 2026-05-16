# SDK Quickstart

`@unbrowse/sdk` is the thin TypeScript client for the local runtime. It auto-spawns the runtime if one is not running.

```bash
npm install @unbrowse/sdk
```

```ts
import { Unbrowse } from "@unbrowse/sdk";

// Probe localhost, spawn the runtime if nothing is listening. The common case.
const u = await Unbrowse.local();

const resolved = await u.resolve({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});

const result = await u.execute(resolved, { projection: { raw: true } });
```

Three factories, three lifecycles:

* `Unbrowse.local()` probes `127.0.0.1:6969` and spawns the runtime if needed. Right most of the time.
* `Unbrowse.connect(url)` attaches to a runtime you already manage.
* `Unbrowse.spawn({ port })` always spawns a fresh, owned runtime. Useful in tests.

Reused routes can be priced. A paid call returns an HTTP 402 that the SDK raises as a typed error you can catch and retry after settling payment; brand-new agents get a sponsored allowance first. The full SDK reference, including the payment helpers and the typed error hierarchy, lives in the `sdk/` section of this space and in the package README.

The SDK is MIT licensed. The runtime it talks to is distributed as a binary. The split is described in the [Open Source Notice](../OPEN-SOURCE-NOTICE.md).
