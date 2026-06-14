# SDK Quickstart

`unbrowse/sdk` is the TypeScript client for the current Unbrowse contract: one
hole fill from intent plus optional URL/params/approval. It runs in browsers, edge
runtimes, and Node.

```bash
npm i unbrowse
```

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole({
  client: { apiKey: process.env.UNBROWSE_API_KEY },
});

const result = await hole.fill({
  intent: "list tomorrow's events",
  url: "https://calendar.google.com",
});
```

The shell equivalent is:

```bash
unbrowse fill "list tomorrow's events"
unbrowse fill "list tomorrow's events" --url "https://calendar.google.com"
```

Need to inspect route selection? The legacy `Unbrowse` client still exposes
`resolve`/`execute` for debugging and compatibility, but new agents should start
from `createHole().fill(...)`.

Reused routes can be priced. A paid call returns an HTTP 402 that the SDK raises as
a typed error you can catch and retry after settling payment; brand-new agents get a
sponsored allowance first.

The open/closed source split is described in the
[Open Source Notice](../OPEN-SOURCE-NOTICE.md).
