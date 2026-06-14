# Onboarding, identity & the acting/indexing hole

## Onboarding — bind an identity

Every install needs an identity so routes, payouts, and sync have an owner. Unbrowse
resolves it in best-practice order, and you only have to do one thing:

1. **Bound account (recommended)** — an **API key**, obtained from a frontend OAuth login
   or `unbrowse register --email you@example.com`. This is the primary credential: it
   carries sync, payouts, and paid-route spending across machines.
2. **Local self-custody wallet (automatic fallback)** — if no account key is present,
   `unbrowse setup` mints a local Ed25519 wallet at `~/.unbrowse/wallet.json` (keyless, no
   signup). You can **sync** it onto an account later to consolidate earnings.

```ts
import { ensureIdentity, onboardingStatus } from "unbrowse/sdk";

const status = onboardingStatus();
console.log(status.nextStep);     // the one thing to tell the user right now

const id = await ensureIdentity();
// id = { kind: "account" | "wallet", id, synced }
```

`onboardingStatus()` returns `{ identity, hasAccount, hasWallet, nextStep }` — surface
`nextStep` in your UI. `ensureIdentity()` returns an account identity when an API key is
present, otherwise the local wallet (syncing it onto an account if you pass a `sync`
function). Both take injectable resolvers so a frontend can wire its own OAuth/api-key
source.

## The `fill` tool acts — and auto-indexes

`fill` is not read-only. Set `act: true` and it performs the action (execute / fill /
submit), not just search. When acting against a route the network hasn't seen, the fresh
capture is **auto-indexed** so the next call is a fast, reusable route — the
discover → publish loop, automatically:

```ts
import { createHole } from "unbrowse/sdk";
import { queueBackgroundIndex } from "unbrowse/indexer"; // wire the real indexer

const hole = createHole({
  index: queueBackgroundIndex,   // captured routes get indexed here
  autoIndex: true,               // default
});

const r = await hole.fill({ intent: "add the blue shoes to my cart", act: true });
// r.captured === true when a new route was learned; r.indexed === true once indexed
```

Pass `autoIndex: false` (per-hole or per-request) to opt out.

## Keep LLM generation client-side

The "index it nicely" step — naming and describing a captured route — runs **on the
client**, with the agent's own model, via a pluggable `generate` hook. Nothing is sent to
a server LLM:

```ts
const hole = createHole({
  index: queueBackgroundIndex,
  // the agent's OWN model — best practices and generation stay client-side
  generate: async (prompt) => myLLM.complete(prompt), // returns "<name> — <description>"
});

await hole.fill({ intent: "find products on shop.example" });
// the captured route is named + described by YOUR model, then indexed
```

**We generate the description for you — you never have to write one.** With no `generate`
hook, a zero-cost deterministic baseline names and describes the route automatically (no
LLM call at all); wire a `generate` hook and your own cheap model enriches it. Either way
generation stays on your side, under your model and your key — never a server round-trip.
Pass `describe: false` only if you truly want routes indexed with no description.
