# For Investors

This page explains Unbrowse as a product and market wedge, without blurring shipped product and roadmap.

## Positioning In One Sentence

Unbrowse is an execution layer for AI agents that turns brittle browser work into reusable, maintained routes.

The shortest category line is:

Unbrowse is a drop-in replacement for OpenClaw / `agent-browser` browser flows for agents.

That works because buyers already understand the browser slot in the stack. The difference is that Unbrowse does not stop at replaying the page. It learns and reuses the machine-callable route underneath the page.

Publicly, the sharp version is:

- drop-in replacement for browser automation in agent stacks
- roughly ~30x faster on the API-native path
- roughly ~90% cheaper than repeating the browser loop
- turns repeated browser work into reusable route assets instead of pure execution cost

## The Right Comparison

Do not frame Unbrowse as "scraping, but better."

The right comparison is:

- browser automation
- one-off site integrations
- repeated manual rediscovery of the same web workflow

Teams are switching from slow, flaky browser execution and bespoke glue code to reusable execution knowledge.

## The Core Story

The AI agent wave is real.

The infrastructure layer underneath it is still thin.

Most agents can reason about a task, but they still struggle to execute reliably across the long tail of the web.

That gap is where Unbrowse sits.

The product thesis is simple:

- the web already contains the workflows agents need
- those workflows usually live behind browser UIs, not clean public APIs
- if you can learn the request layer once and reuse it later, the economics improve fast

## The Struggling Moment

The demand moment is simple:

- an agent can reason about a task
- the team tries to execute it through a browser
- latency spikes, costs stack up, auth gets brittle, selectors break
- the team realizes they are paying the same discovery tax over and over again

That is the moment Unbrowse is built for.

## What The Wedge Is Today

Unbrowse today is a local-first capability layer for web execution.

It can:

- capture real browser traffic
- learn reusable skills from those captures
- rank and reuse good routes later
- preserve browser-bound auth behavior when sites require it

That is the wedge because it turns a repeated cost center, rediscovering the same site workflow, into a reusable asset.

## What Customers Are Actually Buying

Customers are not buying "access to websites."

They are buying:

- lower execution cost
- faster time to action
- less brittle automation
- maintained route knowledge
- reuse of work they would otherwise repeat themselves

That makes the pitch cleaner and more defensible than broad claims about owning the whole web.

## Why The Product Can Compound

The compounding loop is the important part.

Each successful capture can become:

- a reusable skill
- a better future match for similar intents
- another data point in route reliability
- another piece of marketplace memory

So the product improves with reuse, not only with bigger models.

That matters strategically because model quality alone does not remove the web-execution bottleneck.

Infrastructure does.

## Why This Is Different From Browser Automation

Browser automation replays the human surface.

Unbrowse learns the machine-callable route underneath the surface, remembers it, and reuses it later.

That is not a small optimization. It is a different execution primitive.

Useful shorthand:

- browser automation = repeat the work
- Unbrowse = learn once, reuse later

Another useful shorthand:

- browser for humans = render, click, scrape
- browser for agents = resolve, execute, reuse

## The "Mining The Web" Angle

There is a useful way to frame the upside here.

The modern web contains a huge amount of trapped operational value:

- workflows only exposed through UI flows
- live data not available through public APIs
- long-tail domains nobody wants to integrate one by one
- repeated human browsing labor that has never been turned into reusable infrastructure

Unbrowse is interesting because it can help convert that trapped value into reusable routes.

Not by scraping the entire internet blindly.

By learning high-value workflows from real use, then making those workflows easier to reuse later.

That is closer to mining than browsing:

- discover a valuable route
- verify it
- keep it healthy
- reuse it repeatedly

If that loop works at scale, the web stops looking like a pile of disconnected interfaces and starts looking more like a map of reusable agent actions.

## What Is Real Today

Shipped product:

- CLI and local server
- browser-backed capture
- marketplace-backed reuse
- local-first auth handling
- MCP host integration
- reliability, verification, and drift-aware route health
- x402 / HTTP 402 payment lane with wallet-linked payout identity and current payout routing
- canonical product eval gates in the repo

This is enough to support the current claim that Unbrowse is building a reusable web capability layer for agents.

## What Is Still Roadmap

The paper also describes a larger route economy:

- fuller pricing and attribution beyond the shipped x402 lane
- multi-party contributor payouts
- validator incentives
- stronger attestation and trust machinery

Those pieces are not shipped in full in the current codebase.

They should be read as upside and roadmap beyond the narrower payment path that already ships today.

## How To Read The Opportunity

The near-term opportunity is not "replace the browser."

It is:

- reduce execution cost
- increase reliability
- expand usable web coverage
- build reusable infrastructure that agent products can plug into

If that layer becomes trusted and reused, the marketplace and economic layer become more plausible later.

In other words:

- first prove capability
- then prove reuse
- then broaden pricing, attribution, and trust economics

That sequencing is healthier than pretending the economic layer already exists.

## Messaging Guardrails

Lead with:

- drop-in replacement for browser automation in agent stacks
- ~30x faster on the API-native path
- ~90% cheaper than repeated browser execution
- execution layer for agents
- browser rediscovery tax
- reusable route knowledge
- faster, cheaper, more reliable than repeated browser execution

Avoid leading with:

- protocol
- token
- toll booth
- control point
- "we index the whole web"

## Suggested Reading Order

1. [Unbrowse In Plain English](./plain-english.md)
2. [The Problem](./the-problem.md)
3. [What Is Unbrowse?](./what-is-unbrowse.md)
4. [System Today](./system-today.md)
5. [Paper vs Product Status](./paper-vs-product.md)
6. [Coming Soon](./coming-soon.md)

## The Investor Takeaway

Unbrowse is easiest to understand as infrastructure for agent execution, not as another agent wrapper.

The current repo already supports that capability-layer thesis.

The full marketplace economy in the whitepaper is the optional expansion path after the capability layer proves out.
