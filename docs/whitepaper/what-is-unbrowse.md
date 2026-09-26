# What Is Unbrowse?

Unbrowse compiles websites into APIs, and APIs into tools agents call.

It watches how a site actually works at the network layer, turns that into a reusable capability, and lets later agents call the capability instead of driving the site again.

## The core move

Most agent tooling works at the visible layer:

- load a page
- read the DOM or a screenshot
- click through the interface
- wait
- repeat

Unbrowse works one layer down. It learns the requests behind the interface, then replays those requests over HTTP. A browser is used to learn, and as a fallback for reads HTTP cannot finish.

## The product today

Unbrowse is a hosted service with an open-source client.

- **The hosted service** runs a cloud browser, learns capabilities from recorded sessions, replays them, and keeps a vault and a public registry.
- **The client** (this repo) is a thin CLI. It calls the service's REST API. It runs no browser.

The loop:

1. An agent asks for a task.
2. The service checks the caller's private space, then the public registry.
3. If a capability fits, it replays over HTTP.
4. If not, the agent does the task once in the cloud browser. The task gets done, and the session is recorded.
5. The service compiles the session into a capability. Later runs replay it.

## Why this matters

Reuse. One recorded session can serve every later run. The work moves from "figure out the site every time" to "learn once, call many times".

## What not to overclaim

It is accurate to say Unbrowse ships:

- learning from recorded browser sessions and HAR files
- HTTP replay with verified outcomes
- a render fallback for reads HTTP cannot finish
- a public registry of read-only site tools
- a password manager the model never reads, with auto sign-in
- a flat meter (500 verified calls a month free, then $10 per 10,000) and x402 pay-per-call

It is not accurate to say Unbrowse ships:

- a route marketplace with per-route prices
- contributor payouts or fee splits
- validator markets or cryptographic attestation
- local browsing in the client

Those belong in [Coming Soon](./coming-soon.md).

## Read next

- [The Problem](./the-problem.md)
- [How It Works](./how-it-works.md)
- [System Today](./system-today.md)
