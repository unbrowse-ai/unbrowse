# Drop-in adapters

Unbrowse adapters preserve familiar library shapes while routing work through
the same high-level hole API.

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const result = await hole.fill({
  intent: "find recent agent research",
  url: "https://arxiv.org",
});
```

Adapters for Exa, Tavily, Firecrawl, and browser-use normalize their result
objects from `HoleResult`. Authentication uses the account API key supplied to
the underlying client. Metered work uses account credits without an adapter-
specific payment flow.

Use an adapter when an existing application already depends on that provider's
method shape. New code should prefer `createHole()` or the typed `Unbrowse`
client directly.
