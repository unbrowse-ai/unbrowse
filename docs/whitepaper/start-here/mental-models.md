# Mental Models

Technical architectures are easier to reason about when you have the right analogy. Here are three ways to think about what Unbrowse does, each emphasizing a different aspect of the system.

## 1. DNS for APIs

DNS translates human-readable domain names into IP addresses. You type `google.com`; DNS resolves it to `142.250.80.46`. The first lookup hits a remote server. Subsequent lookups hit a local cache. The system is shared -- one resolution populates caches that benefit everyone.

Unbrowse does the same thing, but for intents instead of domain names. An agent says "get the top stories from Hacker News." Unbrowse resolves that intent to a callable API endpoint: `GET https://hacker-news.firebaseio.com/v0/topstories.json`. The first resolution may require a marketplace lookup or even a browser session. Subsequent resolutions hit the local cache.

The parallel extends to the caching hierarchy. DNS has local cache, recursive resolver, and authoritative nameserver. Unbrowse has local route cache, shared marketplace, and browser-based discovery. Each layer is progressively more expensive and progressively less likely to be needed.

As described in the paper's three-path model (Section 3), this layered resolution is what turns a 30-second browser interaction into a 100-millisecond cache hit.

## 2. Package Manager for Web Capabilities

When a developer needs an HTTP client, they do not write one from scratch. They run `npm install axios` and get a tested, documented, versioned package built by someone else. The cost of creation is paid once by the author. The cost of use is near zero for everyone after.

Unbrowse applies the same model to web capabilities. When an agent discovers how to interact with a site -- its endpoints, auth patterns, response schemas -- that knowledge is packaged into a skill manifest and published to a shared registry. Other agents install and use that skill without repeating the discovery work.

Like a package manager, Unbrowse handles versioning and staleness. Endpoints are re-verified periodically. When a site changes its internal APIs, the skill manifest is updated or deprecated. Agents that depend on a skill get the latest working version, not a stale snapshot from six months ago.

The paper's economic model (Section 5) formalizes this: use the shared graph whenever the cost of a lookup is cheaper than the cost of rediscovery. For most sites, it is cheaper by an order of magnitude.

## 3. Mining the Web

Think of each website's internal APIs as a natural resource buried under the surface. The surface is the rendered UI -- what humans see. Underneath it are structured, callable endpoints that do the real work.

Browser-first agents are surface dwellers. They interact with what is visible, clicking through the UI to get things done. It works, but it is slow and effortful -- like gathering resources by hand.

Unbrowse agents are miners. They dig below the surface to find the structured APIs underneath, extract them, and make them available for reuse. Each discovery enriches the shared route graph, making future extraction cheaper.

The shared graph grows as more agents use more sites. Early adopters do the hard work of discovery. Later users benefit from an increasingly complete map. Over time, the browser fallback path fires less and less often -- not because it is disabled, but because the routes it would discover already exist in the shared index.

This is the network effect at the heart of the paper's thesis: the system becomes more valuable with every agent that uses it, because every new discovery is shared.

## Read Next

* [The Problem](the-problem.md) -- the discovery tax these models address
* [What Is Unbrowse?](what-is-unbrowse.md) -- the system behind the analogies
* [How It Works](how-it-works.md) -- a concrete walkthrough
