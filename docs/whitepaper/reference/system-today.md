# System Today

This page describes the Unbrowse system that exists in the codebase today, not the full forward-looking system described in the paper.

## Product Shape

Unbrowse currently ships as:

* a local CLI
* a local HTTP server, defaulting to `http://localhost:6969`
* a browser-backed capture runtime using Kuri
* a shared marketplace for discovered skills
* an MCP server mode for agent hosts

The core user flow is:

1. Ask Unbrowse for a task in natural language.
2. Unbrowse checks local caches and the shared marketplace.
3. If a good skill exists, it executes directly.
4. If not, Unbrowse captures the site, learns endpoints, and can publish the learned skill for reuse.

## Execution Paths That Exist Today

The whitepaper describes a three-path execution model. The codebase has a practical version of that today:

* Local cache Route cache, domain cache, and recent published-skill cache reduce repeat work.
* Marketplace reuse Unbrowse searches the shared marketplace and ranks candidate skills by composite score.
* Live capture fallback If no viable skill exists, Unbrowse launches the browser runtime, captures traffic, reverse-engineers endpoints, and executes from the learned path.

There is also a DOM fallback for pages where API-style replay is not viable.

## Discovery and Publishing

Passive discovery from real use is real and implemented:

* captures observe real browser traffic
* heuristics filter noise and rank likely API endpoints
* extracted endpoints become skill manifests
* successful live captures can be published back to the marketplace
* local cache is seeded immediately even if remote indexing lags

This means the product already behaves like a shared memory layer for web capabilities, even though the economic layer in the paper is not yet shipped.

## Marketplace and Search

The marketplace in code today supports:

* skill publish and fetch
* domain-aware search
* semantic ranking
* endpoint reliability scoring
* verification status
* skill lifecycle management
* issue reporting
* agent registration

The current composite score in the orchestrator follows the paper’s broad shape:

* 40% embedding similarity
* 30% reliability
* 15% freshness
* 15% verification

## Auth and Local-First Security

The local-first security story in the codebase is real:

* capture and execution are local by default
* credentials stay on the user’s machine
* auth state is stored in the local vault
* the vault falls back to encrypted file storage when native keychain bindings are unavailable
* published skills reference auth profiles, but credentials themselves are not published

## Integrations That Ship

The codebase already supports:

* CLI usage
* local HTTP API
* MCP via `unbrowse mcp`
* skill-compatible hosts via `SKILL.md`
* OpenClaw plugin path
* major host wiring flows surfaced in the frontend and installer

The paper’s broader “coverage layer for agents” thesis is therefore directionally true today, even though some protocol and monetization claims remain forward-looking.

## Quality, Drift, and Verification

Quality control today is simpler than the paper’s full trust architecture, but it exists:

* endpoint reliability scores
* user feedback folded into scoring
* schema drift detection
* periodic re-verification of safe GET endpoints
* auto-disable or deprecate bad routes

What does not yet exist is a full validator market, staking, slashable attestations, or cryptographic verification proofs.

## What To Read Next

* Read [Paper vs Product Status](paper-vs-product.md) for a line-by-line audit.
* Read [Coming Soon](coming-soon.md) for the route economy and trust-layer pieces that are still forward-looking.
