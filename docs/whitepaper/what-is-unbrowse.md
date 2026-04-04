# What Is Unbrowse?

Unbrowse is a local-first web capability layer for agents.

It captures how a site actually works at the network layer, turns that into reusable skills, and lets later agents reuse those skills instead of re-learning the site from scratch.

## The Core Move

Most agent tooling tries to operate at the visible UI layer:

- load a page
- inspect the DOM or screenshots
- click through the interface
- wait for the next page
- repeat

Unbrowse works lower in the stack.

It learns the structured requests behind the interface, then replays those requests directly when possible. When a site is strict about browser state, it can execute through a real browser context to preserve cookies, CSRF, redirects, and other browser-bound behavior.

## The Product Shape Today

In the current repo, Unbrowse ships as:

- a CLI
- a local server
- a Kuri-backed browser capture runtime
- a shared marketplace for learned skills
- an MCP server mode for agent hosts

The practical product loop is:

1. An agent asks for a task in natural language.
2. Unbrowse checks local caches and the shared marketplace.
3. If a strong route already exists, it executes immediately.
4. If not, it captures the site, learns candidate endpoints, and executes from that learned path.
5. Successful routes can then be reused by later agents.

## Why This Matters

The big benefit is reuse.

One good capture can become a reusable skill for every later run. That shifts the product away from "figure the site out every time" and toward "learn once, reuse many times."

That is the part of the whitepaper that is already real in the codebase today.

## What Not To Overclaim

The old docs and the whitepaper sometimes blended the current capability layer with the forward-looking route economy.

Today, it is accurate to say Unbrowse ships:

- reusable learned skills
- local-first capture and execution
- marketplace-backed reuse
- reliability scoring, verification, and drift handling
- x402 / HTTP 402 payment-gated marketplace paths
- wallet-linked creator payout identity, payment metadata surfaces, and current payout routing

Today, it is not accurate to say Unbrowse already ships the full paper economy:

- multi-party fee splits across contributors, infra, and treasury
- paper-style dynamic route pricing and fee ceilings
- validator staking or slashing
- TEE or E2B-based attestation

Those belong in [Coming Soon](./coming-soon.md).

## Read Next

- [The Problem](./the-problem.md)
- [How It Works](./how-it-works.md)
- [System Today](./system-today.md)
