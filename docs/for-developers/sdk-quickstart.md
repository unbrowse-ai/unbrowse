# SDK Quickstart

`unbrowse/sdk` is the thin HTTP-first TypeScript client for the hosted Unbrowse API. It runs in browsers, edge runtimes, and Node 18+.

```bash
npm i unbrowse
```

```ts
import { Unbrowse } from "unbrowse/sdk";

const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });

const resolved = await unbrowse.resolve({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});

const result = await unbrowse.execute({
  endpoint_id: resolved.available_operations![0].endpoint_id,
  params: {},
});
```

Need a local browser session owned by your process? Use the legacy local-runtime SDK:

```bash
npm install unbrowse/sdk
```

Its three factories are `Unbrowse.local()`, `Unbrowse.connect(url)`, and `Unbrowse.spawn({ port })`.

Reused routes can be priced. A paid call returns an HTTP 402 that the SDK raises as a typed error you can catch and retry after settling payment; brand-new agents get a sponsored allowance first. The full SDK reference, including the payment helpers and the typed error hierarchy, lives in the `sdk/` section of this space and in the package README.

Both SDK packages are MIT licensed. The local runtime binary is distributed separately. The split is described in the [Open Source Notice](../OPEN-SOURCE-NOTICE.md).
