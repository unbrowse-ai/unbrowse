# For Investors

Unbrowse as a product and a market wedge, with shipped product and roadmap kept apart.

## In one sentence

Unbrowse turns a website into tools an AI agent can call: it learns the site's own requests once in a cloud browser, then replays them over HTTP.

## The right comparison

Not "scraping, but better". The comparison is:

- browser automation (Playwright, Puppeteer, browser agents)
- one-off site integrations
- teams rediscovering the same web workflow again and again

## The problem

Agents can reason about a task. They still struggle to execute it across the long tail of the web:

- latency from driving pages
- cost from long page dumps in the model's context
- brittle selectors and logins
- the same discovery work paid for every run

Most useful workflows live behind browser interfaces, not public APIs.

## What ships today

A hosted service plus an open-source client.

- An agent does a task once in Unbrowse's cloud browser. The task is done, and the site is learned.
- Later runs replay the learned requests over HTTP.
- Outcomes are verified before they count. HTTP 200 is not success.
- A public registry of pre-indexed site tools, each site installable as its own MCP server.
- A password manager the model never reads, with automatic sign-in and session reuse.
- Remote MCP, REST, a CLI and a TypeScript client.

## Evidence

Paper (arXiv:2604.00694), 94 domains: 3.6x mean and 5.4x median speedup on warmed routes versus Playwright; 90–96% per-task cost reduction.

Service's own production evaluations (details and dates in [Evaluation](./evaluation.md)):

- On its demo booking site, median warm replay was 1,974 ms against 36,723 ms median browse.
- A real LLM agent with only the Unbrowse tools booked on an unseen site, then rebooked through replay with 0 browser opens, in 4 tool calls instead of 12.
- On 100 real sites driven by a generic script, 42 replayed a new query correctly with no browser.
- A 200-tool sample of the public registry answered unseen inputs 83% of the time with 0 false successes. The target is 85%; not met yet.

## Business model

- 500 verified calls a month free, then $10 per 10,000.
- Only verified successes bill. Failures, refusals and policy denials are free.

## Why it can compound

Each learned site becomes:

- a tool the next agent can call without browsing
- run history that makes routing and health hints sharper
- if read-only and public, an entry in the shared registry for everyone

The product improves with use, not only with bigger models.

## Browser automation vs Unbrowse

- browser automation: repeat the work every time
- Unbrowse: learn once, call many times

## What is still roadmap

The paper describes a larger route economy:

- prices per route, tied to what rediscovery would cost
- payouts and attribution for people who teach and maintain routes
- site-owner compensation
- validators and cryptographic attestation

None of this ships. Today's pricing is one flat meter. See [Coming Soon](./coming-soon.md).

## How to read the opportunity

Sequence:

1. prove capability: tasks work on real sites
2. prove reuse: learned tools answer later calls
3. then broaden pricing, attribution and trust

Steps 1 and 2 have production evidence, with known gaps (42/100 on the site sweep, the registry sample below its bar). Step 3 has not started.

## Messaging guardrails

Lead with:

- learn once, call over HTTP after
- verified outcomes, not HTTP 200
- the model never sees passwords
- paper results cited as the paper's; service results with their evaluation and date

Avoid:

- claiming the route economy, payouts or validators exist
- quoting paper speedups as product measurements
- "works on any site": the 100-site sweep says otherwise
