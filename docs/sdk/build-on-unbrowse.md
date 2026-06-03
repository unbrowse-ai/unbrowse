# Build on Unbrowse — A Plan for Developers

Unbrowse is not just a tool you call; it's a platform your product can stand on. This doc is the opinionated guide to *building* with it: which archetypes work, how to compose, when not to use it.

> If you only need to consume APIs from sites, see [developer-recipes.md](./developer-recipes.md).
> If you want to *build a product or business* on the platform, this is the plan.

## What Unbrowse gives you as a primitive

Five capabilities you can compose, not just one:

1. **Intent → API resolution.** `resolve(intent, url)` returns a ranked shortlist of callable endpoints. Cache hit: <200ms. Miss: live capture, reverse-engineer, publish, return.
2. **Marketplace of captured routes.** Every successful capture is reusable by any other agent. You inherit the routes other operators captured; they inherit yours.
3. **x402 micro-payments.** Per-execution USDC settlement on Solana. Earnings auto-attribute to your wallet; spending pulls from the same wallet.
4. **Local-first runtime.** Captures, auth, and replays stay on the operator's box by default. Marketplace publishes only the route shape, never response bodies.
5. **Headless Chrome with cookie injection.** Auth is reused from the user's real Chrome/Firefox profile, so gated sites work without re-logging in.

Treat these as five independent legos. The interesting products combine 2-4 of them.

## Build archetypes

Pick one of these as your starting point. Each is a real category of product that fits Unbrowse's grain.

### Archetype A — Vertical AI agent on top of a specific domain

Examples: an AI recruiter that lives in LinkedIn, an AI procurement bot for industrial suppliers, an AI booking concierge.

You leverage:
- Unbrowse for *site coverage* (resolve handles the long-tail of vendor SaaS without you maintaining scrapers)
- Auth import for gated sites
- The marketplace to inherit routes already captured by other operators

Build cost: 1-2 weeks for the wrapper agent + domain prompt; Unbrowse covers most of what would otherwise be 6 months of scraper maintenance.

### Archetype B — Marketplace producer / data validator

Examples: a fleet of agents whose business is mining the marketplace; a paid "fresh routes" service.

You leverage:
- Resolve + execute as the work loop
- `feedback()` to push your validator reputation up
- x402 earnings as direct revenue

Build cost: 2-4 weeks for the orchestration layer. Revenue starts on day one (small) and compounds with reputation.

See [onboarding-validators.md](./onboarding-validators.md) for the operational manual.

### Archetype C — Workflow automation tool with web steps

Examples: Zapier-for-AI-agents, an autonomous research analyst, an outbound-sales operator.

You leverage:
- Unbrowse as the "web step" primitive in a longer DAG
- Captured routes as repeatable workflow nodes
- `next_actions` handoffs for human-in-the-loop fallbacks

Build cost: 3-6 weeks. The win is *deterministic replay* — every web step you ran once is now a callable function for your DAG.

### Archetype D — MCP / OpenClaw server for an org

Examples: an internal MCP that gives your engineering team's Claude Code access to your private internal SaaS apps (Jira, Notion, Linear, your own dashboards).

You leverage:
- Local-only mode (no marketplace publishing for private domains)
- Auth import from the user's real browser
- The MCP protocol surface that ships with `unbrowse mcp`

Build cost: 1 week. The product *is* configuration plus access policy.

### Archetype E — Browser-augmented copilot

Examples: a side-panel browser extension that turns the page the user is on into a callable API for their AI; a Cursor-style IDE where every doc page becomes a tool.

You leverage:
- Resolve with `contextUrl` set to the user's current tab
- Captured routes as on-the-fly tools
- `commitment_only` proofs for traceability

Build cost: 2-4 weeks. The novelty is the UX, not the platform.

## Composition patterns

Once you've picked an archetype, you'll hit one of these patterns. Each has a default answer.

### Pattern 1 — Resolve, then let the LLM pick

The two-tool-call contract (see [resolve.md](../../packages/sdk/docs/api-reference/resolve.md)). Don't auto-execute. Show the agent `available_endpoints`, let it choose, then call `execute`. Builders who skip this end up debugging "why did it call the wrong endpoint" forever.

### Pattern 2 — One runtime per worker

For any fleet >5 concurrent calls, run multiple Unbrowse runtimes (distinct `UNBROWSE_PORT` + `UNBROWSE_HOME`). One shared runtime serializes capture and tanks throughput.

### Pattern 3 — Auth in, auth out

Either use `login()` (interactive) on dev boxes or `importAuth()` from a real Chrome profile on production boxes. Don't try to inject cookies you scraped from somewhere else; vendor security catches that fast.

### Pattern 4 — Feedback closes the loop

Every `execute` should be followed by `feedback({ outcome })`. This is the only signal the marketplace ranker has for "this skill is good vs. broken." Skipping feedback means your published skills will eventually be demoted and your validator reputation flatlines.

### Pattern 5 — Treat misses as explicit handoffs

When `available_endpoints` is empty, read `next_actions[0].command`. Don't loop `resolve` on the same URL. The runtime is telling you what to do next; trust it.

### Pattern 6 — Privacy boundary on internal domains

Use `unbrowse settings --publish-blacklist <domain>` for any internal/PII-bearing site. Captured patterns from those domains never reach the marketplace.

## Phased build plan

For builders going from zero to production, expect roughly:

### Week 1 — Local prototype
- `npm install -g unbrowse unbrowse/sdk`
- `unbrowse setup` + wallet
- Wire SDK into a single test agent
- 5-10 manual `resolve`/`execute` calls against your target sites
- Confirm cache hits on iteration 2+

Goal: prove the basic loop on YOUR domains.

### Weeks 2-3 — Integration with your product
- Move from manual calls to a worker pool (one runtime per worker)
- Add `feedback()` loop
- Add `clientId` per worker for payout attribution (if relevant)
- Wire `next_actions` handoffs into your error-recovery flow

Goal: 100s of real intents per day, observable failure modes.

### Weeks 4-6 — Hardening
- Set up monitoring: track resolve cache-hit rate, `next_actions` distribution, per-domain success rate
- Decide private vs. public per domain (publish-blacklist)
- Pick a wallet provider and load it (Crossmint Lobster recommended for headless)
- If gated sites: lock down `importAuth` source profiles

Goal: the system is observable and the failure modes are named.

### Months 2-3 — Scale
- Multi-machine fleet (one runtime per box, distinct `UNBROWSE_PORT`)
- Reputation accumulation: feedback hygiene matters now
- Paid x402 routes if your domain is in the marketplace's paid tier
- (Optional) MCP / OpenClaw exposure to make your wrapper consumable by other agents

Goal: the platform disappears into your product. Customers don't think about Unbrowse; they think about your agent.

## Extension points

Where you can plug in instead of waiting for the platform.

| Hook | What it lets you do | Surface |
|---|---|---|
| Custom `fetch` | Route through a residential proxy, instrument every call, run in offline mode | `new Unbrowse({ fetch })` |
| Custom `headers` | Add tracing headers, mTLS client cert hooks, client-tier identification | `new Unbrowse({ headers })` |
| `confirmThirdPartyTerms` | Per-domain ToS gate; default-deny third-party-restricted captures | resolve/execute input |
| `feedback({ diagnostics })` | Feed your own quality signal (wrong-endpoint detection, latency anomalies) into ranker | feedback input |
| `unbrowse settings --publish-blacklist` | Domain-level privacy policy enforced in the runtime | CLI |
| Local-only mode | Run with no marketplace publish at all (set `UNBROWSE_PUBLISH=off`) | env |

What's NOT yet a documented extension point but is on the roadmap:
- Custom ranker plugins (local override of marketplace ranking)
- Custom proof systems beyond `commitment_only` (stronger provenance schemes are an active research direction; details will follow in a forthcoming whitepaper)
- Custom payment rails (non-x402 settlement)

If you need any of these, file an issue or email security@unbrowse.ai for an NDA discussion.

## When NOT to build on Unbrowse

Be honest about the misfit cases. Don't pick the platform if:

- **You only need one site.** If your entire product is "scrape exactly this one API," a hand-built scraper is faster than learning Unbrowse. Unbrowse pays off when you cover dozens to hundreds of sites.
- **You need millisecond latency.** Cache hits are <200ms but not <10ms. If you're building HFT-adjacent stuff, this is the wrong layer.
- **You can't accept x402 / Solana / USDC settlement.** The earnings rail is fixed. You can run local-only with no earnings, but if your business model needs a different rail, that's a hard mismatch today.
- **Your target sites have iron-clad ToS prohibitions you must respect.** Unbrowse is a capability, not a license. `confirmThirdPartyTerms` is your gate, but the legal call is yours.
- **You need cryptographic origin proofs today.** `commitment_only` is tamper-evident, not cryptographic. Stronger provenance schemes are an active research direction; specifics will be detailed in a forthcoming whitepaper.

## Distribution channels for what you build

Once you've built something on Unbrowse, where does it ship?

1. **As an npm package** that depends on `unbrowse/sdk`. Standard.
2. **As an MCP server** so any Claude Code / Cursor / etc. user can mount your wrapper. The Unbrowse runtime already speaks MCP via `unbrowse mcp`; you can layer your own MCP server on top.
3. **As an OpenClaw plugin** so the agent's default browser auto-routes through your wrapper. See `openclaw` metadata in [the packaged skill manifest](../../SKILL.md).
4. **As a hosted endpoint** (your service runs Unbrowse, exposes a thin API to your customers). The SDK runs server-side fine.

## See also

- [SDK API reference](../../packages/sdk/docs/api-reference/) — the actual call surface
- [Developer recipes](./developer-recipes.md) — composition patterns at the call level
- [Onboarding validators](./onboarding-validators.md) — operating a fleet
- [Rewards & economics](./rewards-and-economics.md) — the payment layer
- [Open source notice](../OPEN-SOURCE-NOTICE.md) — what's MIT vs. proprietary
- [Whitepaper: network layer](../whitepaper/network-layer.md) — the long-form economic + architectural model
