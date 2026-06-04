# Unbrowse UX — product-nerd user stories (first-principles)

The job: make the product's *felt experience* deliver what the papers promise. Each
story is one node — **persona · job · context · the promise it fulfils · the UX
moment · the proof it landed** — derived from a real paper claim and a real surface,
not invented. Taste rubric at the bottom; every story is checked against it before it
ships. Ordered cheapest-first to the first felt win.

## Personas (who)

- **Aria — the agent author.** Wiring an LLM agent to real websites. Hates writing
  brittle scrapers; wants a route she calls once and trusts. Lives in a terminal + an
  MCP host (Claude/Cursor).
- **Devin — the curious dev.** Heard "any website becomes an API." Has 60 seconds and
  one tab. Will bounce if the first screen doesn't *show* it, not tell it.
- **Mara — the site owner / maintainer.** Wants to know if routes to her site earn,
  and that her users' creds are safe. Skeptical of "crypto."

## The promises (why — from the papers)

1. **Wedge:** capture once, replay everywhere — a reusable route beats re-deriving the
   web every call; ~3.6× faster, ~40× fewer tokens (arXiv:2604.00694).
2. **Trust:** one key signs every layer; credentials bound by zero-knowledge proof and
   revealed only under signature; results content-addressed and sealed.
3. **Network:** the maintained graph is the asset; usage settles fairly to indexer,
   site owner, platform; freshness is bonded, not promised.

## Stories (each node: job → moment → proof)

### S1 · Devin sees it work in one screen *(cheapest first win)*
- **Job:** "Show me, in 10 seconds, that a website became an API."
- **Surface:** homepage hero + `/aiko` chat.
- **Promise:** wedge (1).
- **Moment:** the hero is not a paragraph — it's a live input. Devin types an intent
  ("top stories on Hacker News"), hits enter, and sees a *real ranked endpoint +
  real data* stream back, with a tiny "resolved in 1 call · vs a browser session"
  badge. No signup wall before the first result.
- **Proof (settles when):** time-to-first-real-result < 10 s on a cold visit; the
  result is genuine data, not a canned demo; the speed/cost badge shows a real delta.
- **Taste gate:** *useful* + *understandable* — the value is demonstrated, not claimed.

### S2 · Aria installs and gets her first route in under a minute
- **Job:** "Get unbrowse into my agent and resolve one intent — fast, no yak-shaving."
- **Surface:** `/install` → MCP setup → first `resolve`.
- **Promise:** wedge (1).
- **Moment:** one copy-paste (`npx unbrowse setup`) wires the MCP server; the very
  next thing she sees is a worked `resolve → execute` that returns real data, with the
  two-tool workflow (resolve, execute) named plainly — never three, never one.
- **Proof:** a fresh machine reaches a real executed route in < 60 s; the quickstart
  command is the *only* required step; no `[kuri-proxy]` / trace noise clutters the
  terminal on a plain command *(already fixed — clean `--help`)*.
- **Taste gate:** *less but better* — one path, no decision fatigue.

### S3 · Aria trusts a route enough to put a credential behind it
- **Job:** "Let my agent act as me on a logged-in site without leaking my session."
- **Surface:** `auth` capture flow + the trust story on `/classic` or `/docs`.
- **Promise:** trust (2).
- **Moment:** after `unbrowse auth`, the UI states — in one calm line — *what is bound*
  (a credential is bound to your key) and *what never leaves* (the secret itself,
  never the bytes). The scary part (crypto) is shown as safety, not jargon.
- **Proof:** the flow shows the credential is bound and sealed without ever printing
  the secret; a user can read one sentence and correctly say "my password never left."
- **Taste gate:** Nielsen *visibility of system status* + *error prevention* — trust is
  legible, not a leap of faith.

### S4 · Mara sees her site earns, and opts in without a coin pitch
- **Job:** "Do routes to my site pay me? Is this safe for my users?"
- **Surface:** `/how-unbrowse-pays`, `/claim`, dashboard earnings.
- **Promise:** network (3).
- **Moment:** the money story is plain — *USDC settles usage; the token only bonds
  trust* — who pays, who earns, shown as a split, never as an investment narrative.
  Claiming her domain reads her real on-chain payouts, not a projection.
- **Proof:** earnings shown are real reads (the `/v1/claim/earnings` endpoint), labelled
  honestly; the page passes a "would a skeptic of crypto still trust this?" read.
- **Taste gate:** *honest* (CLAUDE.md) — the what is fully disclosed; only money-as-motive
  is denied.

### S5 · Aria escalates from local to cloud without a context switch
- **Job:** "Run the cheap local model for quick stuff; reach for the big one when it
  matters — in the same place."
- **Surface:** `/aiko` chat model toggle *(shipped this session)*.
- **Promise:** wedge economics (1) — pay only when you must.
- **Moment:** a single header toggle: local (free, on your Mac) → cloud (max). The
  method is the same; only the muscle changes. Default is local, so the first try costs
  nothing and stays private.
- **Proof:** the local default returns a real answer with zero spend; toggling to cloud
  is one click; the method/voice is identical across tiers *(witnessed: 4/4 method
  steps on the local model)*.
- **Taste gate:** *less but better* — one surface, graduated power.

## Taste rubric (every story passes all three before it ships)

1. **Rams root — useful, understandable, less but better.** If a screen *tells* instead
   of *shows*, or adds a choice that isn't load-bearing, cut it.
2. **Nielsen seal — no usability violation ships.** Visibility of status, match to the
   user's language (not ours), error prevention, recognition over recall.
3. **Double-diamond loop — diverge then converge, on the problem then the solution.**
   On a failed preview, return to the *problem* (the persona's job), not to pixels.

## What's settled vs open (honest ledger)
- **[shipped]** S2 terminal cleanliness (clean `--help`); S5 local/cloud aiko toggle + baked method.
- **[next]** S1 cold-visit first-result instrumentation; S3 trust-legibility copy; S4 skeptic-proof money page.
- **[gate]** each preview ships to a real reviewer; the UX is "done" only when a real
  product-taste reviewer signs off on the felt experience — not on this document.
