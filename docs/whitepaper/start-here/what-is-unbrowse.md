# What Is Unbrowse?

Unbrowse is a shared route graph for the web. It turns the expensive, one-off process of discovering how a website works into a collectively maintained index that any agent can query.

The core idea is simple: when one agent discovers an internal API on a site, that discovery should benefit every agent that needs the same site afterward. Unbrowse is the infrastructure that makes that happen.

## Shadow APIs

The paper introduces the concept of **shadow APIs** -- first-party endpoints that power a website's own user interface but are never documented or exposed as a public API.

Every modern website has them. When a site loads your feed, it calls an internal endpoint. When it shows search results, it fetches from an internal search API. These endpoints accept structured parameters and return structured data, just like any documented API would. They are simply not intended for external consumption.

Unbrowse captures these endpoints during real browsing sessions, reverse-engineers their schemas and authentication requirements, and packages them into reusable descriptions called **skill manifests**. A skill manifest for a domain contains its discovered endpoints, their URL templates, parameter schemas, expected response shapes, and auth descriptors -- everything another agent needs to call those endpoints without rediscovering them.

## Shared Discovery

The key economic insight from the paper (Section 5) is that discovery should happen once, not once per agent.

When an Unbrowse-equipped agent browses a site for the first time, it passively captures the network traffic between the browser and the site's backend. That traffic goes through an enrichment pipeline: endpoints are extracted, auth patterns are identified, and semantic metadata is generated describing what each endpoint does. The result is published to a shared marketplace.

The next agent that needs the same site does not browse at all. It queries the marketplace, finds the existing skill, and executes directly against the discovered endpoints.

As described in Section 3 of the paper, this creates a three-path execution model with dramatically different cost profiles:

1. **Local cache** (under 100ms) -- the route was discovered previously and is cached on the agent's machine. No network lookup, no browser. Direct API call.
2. **Shared route graph** (~1 second) -- the route exists in the marketplace, discovered by another agent. Fetched, executed, and cached locally for next time.
3. **Browser fallback** (8-30 seconds) -- no one has discovered this route yet. Unbrowse launches a browser, captures traffic, reverse-engineers the endpoints, executes the task, and publishes the new skill so the next agent gets the fast path.

The system gets faster as more agents use it. Every browser fallback is an investment that eliminates future browser fallbacks for the same site.

## Skill Manifests

A skill manifest is the unit of shared knowledge in Unbrowse. It is a structured description of a domain's discovered capabilities, typically containing:

- **Endpoints** with URL templates, HTTP methods, and parameter schemas
- **Auth descriptors** specifying how the site authenticates requests (cookies, bearer tokens, API keys, CSRF tokens)
- **Semantic metadata** describing what each endpoint does in natural language
- **Reliability scores** tracking how often each endpoint succeeds
- **Verification state** indicating when an endpoint was last confirmed working

Skill manifests are versioned and maintained. When a site changes its internal APIs, Unbrowse detects schema drift and triggers re-verification.

## The Product Shape

Unbrowse ships as a multi-interface tool designed to work with any agent framework:

- **CLI** -- `unbrowse resolve`, `unbrowse go`, `unbrowse snap`, `unbrowse close`
- **MCP server** -- for agent hosts that support the Model Context Protocol
- **REST API** -- for programmatic integration from any language or framework
- **Local server** -- runs on the agent's machine, manages caches, handles browser lifecycle

The browser runtime is powered by **Kuri**, a Zig-native CDP (Chrome DevTools Protocol) broker that ships as a 464KB binary with approximately 3ms cold start time. Kuri manages the browser process, handles extension loading for anti-detection, and provides the capture infrastructure -- but from the agent's perspective, it is invisible. The agent talks to Unbrowse; Unbrowse talks to Kuri when a browser is needed.

## Read Next

* [How It Works](how-it-works.md) -- step-by-step walkthrough with a real example
* [The Problem](the-problem.md) -- the discovery tax that motivates this
* [Mental Models](mental-models.md) -- analogies for building intuition
