# The Problem

The web was built for humans using browsers, not for agents trying to execute tasks programmatically.

That mismatch creates three common failure modes.

## 1. Custom Site-by-Site Integrations Do Not Scale

Building one-off integrations or scrapers per site is expensive, slow, and fragile.

Even when it works, it creates a maintenance burden:

* site changes break the integration
* long-tail site coverage stays poor
* every team repeats the same reverse-engineering work

## 2. GUI Automation Is Too High-Friction

Browser automation can work, but it forces the agent through the visible interface:

* load page
* inspect UI
* click
* wait
* handle popups
* retry

That is often the wrong abstraction layer for sites whose real logic lives in structured network requests behind the UI.

## 3. Official APIs Cover Only a Small Slice of the Web

Official APIs are great when they exist and when they expose the needed workflow.

But many useful sites either:

* do not have public APIs
* restrict them heavily
* expose only partial workflows
* make them unsuitable for the exact agent task

## The Real Infrastructure Gap

Agents are often smart enough to understand what to do, but they are missing a stable way to use the web at the level where sites actually operate.

That is the problem Unbrowse is solving:

* learn the internal request patterns
* preserve auth and browser parity when needed
* reuse that work across later runs

## Why The Timing Matters

The whitepaper is directionally right that agent demand is increasing faster than web infrastructure for agents.

The current repo already reflects that pressure in practical product choices:

* local-first execution
* fast reuse from caches and marketplace search
* live capture fallback when no route exists
* canonical evals that judge retrieval, selection, and execution together

So the problem is no longer hypothetical. The product is already built around it.

## Read Next

* [Mental Models](mental-models.md)
* [How It Works](how-it-works.md)
* [Paper vs Product Status](../reference/paper-vs-product.md)
