# Search on top of Unbrowse

Search asks the shared route graph for endpoints matching an intent.

```bash
unbrowse search --intent "find stock prices" --domain finance.yahoo.com
```

Or in TypeScript:

```ts
const result = await unbrowse.search({
  intent: "find stock prices",
  domain: "finance.yahoo.com",
  limit: 5,
});
```

Search results are candidates, not fabricated successes. Execute a selected
endpoint to obtain data. If search or execution is metered, the service deducts
account credits; insufficient balance returns a normal typed error.
