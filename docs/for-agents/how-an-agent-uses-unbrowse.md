# How an Agent Uses Unbrowse

This page is the operating model for an AI agent that has Unbrowse available.

The current mental model is one step: **fill the hole**. The agent describes the
internet gap it needs filled — intent, optional URL, optional params, and explicit
approval for writes — and Unbrowse decides how to satisfy it. That may mean a
direct document fetch, a shared contract in the route graph, a standard adapter, a
local-auth browser capture, HAR inspection, or indexing a newly discovered route for
the next call.

The agent should not choose between `resolve`, `execute`, `go`, `snap`, `fetch`, HAR,
or cookies for ordinary work. Those are implementation layers under the hole.

The public contract is inspectable:

```bash
unbrowse contract surface
```

It exposes five client-fillable holes:

* `intent`
* `wallet_proof`
* `approval`
* `local_capability_result`
* `typed_pointer`

In code, the same surface is:

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const result = await hole.fill({
  intent: "top stories on Hacker News with point counts",
  url: "https://news.ycombinator.com",
});
```

Use the old route view only when debugging or when a host cannot call the hole
directly. In that compatibility path, resolve gathers candidates and execute replays
one chosen route. It is not the preferred surface for new agents.
