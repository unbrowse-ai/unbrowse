# Hole Contract and Legacy Route View

The current Unbrowse contract is one hole fill. The caller supplies an intent and
optional context; the runtime descends through the graph, adapters, browser capture,
cookies, HAR, and indexing as needed.

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const result = await hole.fill({
  intent: "latest releases from this repository",
  url: "https://github.com/unbrowse-ai/unbrowse",
});
```

From a shell, call the same contract as:

```bash
unbrowse fill "latest releases from unbrowse-ai/unbrowse"
unbrowse fill "latest releases from this repository" --url "https://github.com/unbrowse-ai/unbrowse"
```

The machine-readable shape is:

```bash
unbrowse contract surface
```

## Why the old route view still exists

`resolve` and `execute` are the compatibility decomposition of the same contract.
They are useful when you are inspecting the route graph, debugging a bad endpoint,
or integrating with an older MCP host that cannot call the hole directly.

In that view:

* `resolve` searches local/server contracts and returns candidate endpoints with evidence.
* The agent or debugger judges which candidate matches the intent.
* `execute` runs the selected endpoint with params and projection.
* `feedback` records whether the selected route satisfied the intent.

This is deliberately no longer the default training path for agents. The dogfood
failure mode was obvious: agents guessed CLI verbs and flags instead of submitting
one intent-shaped gap. New integrations should call the hole and let the runtime
pick the descent.

## When to use it

Use the route view for:

* endpoint inspection
* regression diagnosis
* manual replay of a known contract
* old MCP/tool hosts

Do not use it as the default user-task loop. For user tasks, fill the hole.
