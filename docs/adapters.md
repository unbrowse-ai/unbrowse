# Drop-in client adapters

Unbrowse exposes one streaming tool — `fill` — that takes an **intent** (and an optional
URL) and returns whatever fills that internet gap: search results, page contents, or the
answer to a task. Internally it runs the resolve → execute → capture pipeline (API-native
first, browser only as a fallback). Around that one tool, the SDK ships **drop-in
adapters** that mirror the call shapes of popular clients, so migrating is a one-line
import change.

| Replace | With | Construction kept | Methods kept |
|---|---|---|---|
| `exa-js` | `@unbrowse/sdk/adapters/exa` | `new Exa(apiKey)` | `search`, `searchAndContents`, `getContents`, `answer` |
| `@tavily/core` | `@unbrowse/sdk/adapters/tavily` | `tavily({ apiKey })` | `search`, `extract` |
| `browser-use` | `@unbrowse/sdk/adapters/browser-use` | `new Agent({ task })` | `run` |

## The one tool — `fill`

```ts
import { createHole } from "@unbrowse/sdk/adapters";

const hole = createHole();                       // unified streaming tool
const r = await hole.fill({ intent: "latest anthropic papers" });
for (const item of r.items) console.log(item.title, item.url);

// or stream the items as they arrive
for await (const item of hole.stream({ intent: "top HN stories" })) {
  console.log(item.url);
}
```

`fill` returns a normalized result — `{ ok, intent, items[], answer?, source? }` — and every
adapter below simply reshapes those `items` into the client shape you already code against.

## exa — drop-in

```ts
// before:  import Exa from "exa-js";
import Exa from "@unbrowse/sdk/adapters/exa";

const exa = new Exa(process.env.EXA_API_KEY);
const { results } = await exa.search("anthropic news", { numResults: 5 });
// results: { title, url, publishedDate, score, text?, highlights?, summary? }[]
```

## tavily — drop-in

```ts
// before:  import { tavily } from "@tavily/core";
import { tavily } from "@unbrowse/sdk/adapters/tavily";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
const res = await tvly.search("agent infrastructure");
// res: { query, answer?, results: { title, url, content, score, rawContent? }[] }
const ex = await tvly.extract(["https://example.com/post"]);
// ex: { results: { url, rawContent }[], failedResults: string[] }
```

## browser-use — drop-in

```ts
// before:  from browser_use import Agent
import { Agent } from "@unbrowse/sdk/adapters/browser-use";

const agent = new Agent({ task: "find the cheapest direct flight SFO→TYO next month" });
const out = await agent.run();
// out: { task, done, result, items[] } — a real browser opens only if the task needs it
```

## Wallet-protected requests

The tool can be bound to a wallet. When it is, every request carries an Ed25519
attestation over the canonical request — the request is provably yours, and a tampered
request fails verification. Pass any signer that implements `sign(message) → { signature,
walletPubkey }`:

```ts
import { createHole } from "@unbrowse/sdk/adapters";

const hole = createHole({ wallet: mySigner });   // wallet-bound
const r = await hole.fill({ intent: "fill this gap" });
// r.seal = { walletPubkey, signature } — verifiable; only the holder could produce it
```

This is the same pointer-only, wallet-signed receipt model the rest of Unbrowse uses (see
[agent-internet-layer.md](./agent-internet-layer.md)): the request is signed, never the
secret. Stronger authorization and provenance schemes are an active research direction;
specifics will be detailed in a forthcoming whitepaper. The signed-request invariant holds
regardless.

## Why adapt instead of rewrite

You keep your existing code and provider semantics; Unbrowse changes only the transport —
routing the call through learned, reusable API routes (API-native first, browser as the
fallback) and, where configured, settling micro-payments per call. One agent learns a site
once; every later call gets the fast path.
