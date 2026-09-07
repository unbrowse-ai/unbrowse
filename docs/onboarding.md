# Onboarding, identity & the acting/indexing hole

## Onboarding for agents / SDK (zero heavy setup)

For pure SDK / agent usage you do **not** need to run `unbrowse setup`.

- A local self-custody Ed25519 wallet is created automatically the first time `ensureIdentity()` (or `createHole()`) is called.
- No browser install, no interactive TOS, no wallet prompts are required for the HTTP surfaces (resolve, execute, hole, fetch).
- Cloudflare / PerimeterX / Akamai / Kasada challenges are recoverable by passing `recoverChallenge: true` to `createFetch`.

```ts
import { ensureIdentity, onboardingStatus, createHole, createFetch } from "unbrowse/sdk";

// SDK-first path: auto wallet, no CLI setup required.
await ensureIdentity();                 // creates ~/.unbrowse/wallet.json if missing

const status = onboardingStatus();
console.log(status.nextStep);           // human guidance only; not a blocker

const hole = createHole();
const r = await hole.fill({ intent: "top stories", url: "https://news.ycombinator.com" });

// Opt-in anti-bot recovery for CF/PX/etc (uses the same solvers the CLI has).
const f = createFetch({ recoverChallenge: true });
const html = await f("https://protected.site");
```

If you later want payouts or cross-machine sync, bind an account key (`UNBROWSE_API_KEY`) or run the lightweight `unbrowse register` / `unbrowse account`.

## Full CLI + browser capture onboarding (when you need `go` / `capture`)

If you need the real browser (login flows you drive by hand, `unbrowse go`, capture of uncached hard sites), then:

```bash
npm install -g unbrowse && unbrowse setup
```

`unbrowse setup` still does the browser engine install + TOS for the capture surface.

## Legacy identity details (for completeness)

1. **Bound account (recommended for payouts)** — an **API key**, obtained from a frontend OAuth login or `unbrowse register --email you@example.com`.
2. **Local self-custody wallet (automatic for SDK)** — created on first `ensureIdentity()` for SDK users; previously only via `unbrowse setup`.

```ts
import { ensureIdentity, onboardingStatus } from "unbrowse/sdk";

const id = await ensureIdentity();
// id = { kind: "account" | "wallet", id, synced }
```

`onboardingStatus()` returns `{ identity, hasAccount, hasWallet, nextStep }`. Both functions accept injectable resolvers for testability.

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
