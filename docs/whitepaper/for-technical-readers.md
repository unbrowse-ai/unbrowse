# For Technical Readers

This page is the fastest way to understand the Unbrowse product that exists in the repo today.

It is intentionally stricter than the whitepaper.

## Positioning Snapshot

Unbrowse is not best understood as a generic browser wrapper.

It is a reusable execution layer that learns routes from real browser traffic, then reuses those routes with ranking, verification, and fallback logic.

The clean category shorthand is:

Unbrowse is a drop-in replacement for OpenClaw / `agent-browser` browser flows for agents.

That does not mean "the browser disappears everywhere." It means agent workflows can keep a browser-shaped interface while Unbrowse swaps repeated UI replay for route resolution and execution whenever it can.

The practical performance pitch is:

- on the API-native path, roughly ~30x faster
- roughly ~90% cheaper than repeated browser execution
- reusable route assets instead of one-off browser work

The closest alternatives are:

- Playwright / Puppeteer-style browser automation
- custom one-off API route discovery
- teams building and maintaining their own private route cache

The useful category label is "execution infrastructure for agent access to the web."

## The Technical Thesis

Unbrowse is a local-first web capability layer for agents.

It does two things:

1. learn structured website routes from real browser traffic
2. reuse those routes later through ranking, verification, and fallback logic

The important product move is not just capture.

It is resolve plus reuse.

## Current System Shape

The codebase currently ships:

- CLI entrypoint
- local HTTP server
- Kuri-backed browser capture runtime
- shared marketplace for discovered skills
- MCP server mode for agent hosts
- local credential vault with encrypted fallback

That means the system already supports both first-run learning and later-run reuse.

## What A Skill Actually Is

A skill is not just a saved URL.

In practice it is a complete execution plan with:

- route and schema knowledge
- auth assumptions
- refresh or replay behavior

