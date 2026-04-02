# The Problem: The Discovery Tax

Every time an AI agent needs to do something on a website, it pays an invisible tax. We call it the **discovery tax** -- the cost of figuring out how a site works before the agent can actually do anything useful.

This tax shows up in three distinct failure modes, each compounding the others.

## Failure Mode 1: Browser Automation Is Slow

The dominant approach to web-capable agents today is browser automation. Load a page, read the DOM or take a screenshot, find the right element, click it, wait for the result, repeat.

It works. But it is slow.

As described in Section 4 of the paper, our benchmark across 94 domains found a median task completion time of 3.4 seconds via browser automation. The same tasks completed in a median of 950 milliseconds when a cached API route was available -- and under 100 milliseconds on subsequent local cache hits. That is a 3.6x speedup at the median, and over 30x when the route is already cached locally.

The latency is not just an inconvenience. It compounds. An agent that chains five web interactions to complete a workflow pays the browser tax five times. A cached agent pays it zero times.

## Failure Mode 2: Official APIs Cover Almost Nothing

The instinctive response is "just use the API." But most of the web does not have one.

Fewer than 5% of the sites agents need to interact with offer a documented, public API. And even when an API exists, it often does not expose the specific workflow the agent needs. Reddit has an API, but it does not let you do everything the site does. Most e-commerce sites, government portals, internal tools, forums, and niche platforms have no programmatic interface at all.

Agents that depend on official APIs are limited to the small slice of the web that has chosen to be programmable. The rest -- the vast majority -- remains locked behind rendered HTML.

## Failure Mode 3: Every Agent Rediscovers the Same Routes

Here is perhaps the most wasteful part. When one agent figures out how to get data from a site, that knowledge dies with the session. The next agent that needs the same site starts from scratch.

Across the ecosystem, thousands of agents independently reverse-engineer the same endpoints on the same sites. Each one loads the same pages, clicks through the same flows, and discovers the same internal API calls. None of them share what they learned.

The paper formalizes this as redundant discovery cost. If N agents each need the same site, browser-first architectures pay the full discovery cost N times. A shared approach pays it once.

## The Hidden Insight

The three failure modes above paint a bleak picture, but they obscure a surprisingly hopeful fact: **the APIs already exist.**

Every modern website is a client-server application. When you load Hacker News, your browser does not receive a blob of static HTML -- it calls `https://hacker-news.firebaseio.com/v0/topstories.json`. When you search on an e-commerce site, your browser sends a structured request to an internal search endpoint and gets back JSON. When you scroll a social feed, your browser fetches paginated data from an API the site built for its own use.

These are what the paper calls **shadow APIs** -- first-party endpoints that power a site's own UI, never documented or intended for external use, but fully functional and structured. They accept parameters, return JSON, and behave like any other API. They are just not advertised.

The problem is not that the web lacks APIs. The problem is that these APIs are undocumented, and every agent has to rediscover them independently through expensive browser automation.

That is the discovery tax. And it is what Unbrowse eliminates.

## Read Next

* [What Is Unbrowse?](what-is-unbrowse.md) -- how shared discovery solves this
* [How It Works](how-it-works.md) -- a concrete walkthrough
* [Mental Models](mental-models.md) -- intuitive analogies
