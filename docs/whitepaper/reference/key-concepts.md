# Key Concepts

Reference definitions for terms used throughout the paper "Internal APIs Are All You Need" and the Unbrowse system.

---

## Shadow API / Internal API

A shadow API is an undocumented HTTP endpoint that a web application uses internally to serve its own frontend but does not expose through any public developer API. Every modern single-page application communicates with its backend through structured requests -- JSON over REST, GraphQL, or gRPC-Web -- that carry the same data a user sees on screen. These endpoints are shadow APIs: they exist, they are stable enough to serve production traffic, and they follow predictable request/response schemas, but they are invisible to external developers because no documentation or SDK references them.

The paper's central thesis is that these internal APIs are sufficient to replace most browser automation. Rather than rendering a page, parsing its DOM, and simulating clicks, an agent can call the underlying endpoint directly -- faster, cheaper, and more reliable.

## Skill

A skill is the unit of packaged knowledge in the Unbrowse system. It corresponds to a single domain (e.g., `reddit.com`) and contains all discovered endpoint descriptors, authentication metadata, extracted schemas, semantic descriptions, and an operation graph linking endpoints together.

Skills are versioned, published to the shared marketplace, and cached locally after first use. A skill is not a wrapper library or an SDK -- it is a machine-readable description of observed API behavior that the execution engine interprets at runtime.

## Endpoint Descriptor

An endpoint descriptor is a structured record representing a single discovered API route. It contains:

- **URL template**: the path with parameterized segments (e.g., `/api/v1/users/{userId}/posts`)
- **HTTP method**: GET, POST, PUT, DELETE, etc.
- **Request schema**: inferred parameter types, required fields, and example values
- **Response schema**: the structure of the returned data, inferred from observed responses
- **Semantic metadata**: an LLM-generated natural-language description of what the endpoint does, what its parameters mean, and what data it returns
- **Auth requirements**: which headers, cookies, or tokens the endpoint expects
- **Reliability score**: historical success rate from execution feedback

Endpoint descriptors are the atomic units that compose a skill.

## Operation Graph

The operation graph is a directed acyclic graph (DAG) where nodes are endpoint descriptors and edges represent data dependencies. An edge from endpoint A to endpoint B means that a value in B's response is required as a parameter in A's request.

Each edge carries `requires` and `provides` bindings that specify which response field maps to which request parameter. This allows the system to plan multi-step API sequences -- for example, first calling a search endpoint to get an item ID, then calling a detail endpoint with that ID.

The operation graph is built automatically during skill enrichment by analyzing URL template parameters against response schemas across all endpoints in a domain.

## Composite Scoring

When the resolve pipeline searches for a matching endpoint, candidates are ranked by a composite score combining four signals:

| Signal | Weight | Description |
|---|---|---|
| **Embedding similarity** | 40% | Cosine similarity between the user's intent (natural language query) and the endpoint's semantic description, computed via vector embeddings |
| **Reliability** | 30% | Historical success rate from past executions -- endpoints that consistently return valid data score higher |
| **Freshness** | 15% | Recency of the last successful verification, subject to exponential decay: `1 / (1 + d/30)` where `d` is days since last verification |
| **Verification status** | 15% | Whether the endpoint passed its most recent automated verification check |

This formula balances semantic relevance against operational trustworthiness, preventing stale or unreliable endpoints from ranking highly even if they match the query well.

## Route Cache

The route cache is a local store of skill-endpoint pairs from prior successful executions. When a user issues a resolve request, the system checks the route cache first. A cache hit means the system already knows which domain, which skill, and which specific endpoint answered this type of query before -- so it can skip marketplace search and browser fallback entirely.

Route cache entries are keyed by a combination of domain, intent pattern, and parameter signature. This is the fastest path: typically under 100ms.

## Shared Route Graph (Marketplace)

The shared route graph is the collectively maintained index of all published skills and endpoints across all Unbrowse users. It functions as a marketplace: when a local cache miss occurs, the system queries the shared graph using vector similarity search over endpoint descriptions.

The marketplace currently indexes over 500 domains and approximately 10,000 endpoints. It serves as the second resolution tier -- slower than local cache but far faster than browser-based discovery.

## Skill Lifecycle

Every skill moves through three states:

1. **Active**: endpoints are verified, fresh, and available for execution
2. **Deprecated**: one or more endpoints have failed recent verification checks; the skill still resolves but with lower confidence scores
3. **Disabled**: the skill has failed verification consistently and is excluded from resolution

A background verification loop runs on a 6-hour cycle, re-testing endpoint availability and schema consistency. Freshness decays continuously using the formula `1 / (1 + d/30)`, meaning an endpoint last verified 30 days ago scores 0.5 on the freshness signal.

## Discovery Tax

The discovery tax is the computational and time cost of finding a working API route through browser-based exploration. This includes launching a browser instance, navigating to the target page, waiting for network requests, capturing traffic, extracting endpoints, inferring schemas, and enriching with semantic metadata.

In the benchmark, cold-start discovery takes a median of 8.2 seconds and a mean of 12.4 seconds. This is the cost that the system amortizes: paid once during first discovery, then avoided on all subsequent uses through caching and sharing.

## Adoption Condition

The economic argument for route reuse is captured by a simple inequality:

> **f_route < c_rediscovery**

Where `f_route` is the fee (time, compute, or monetary cost) to use a cached route, and `c_rediscovery` is the cost of discovering that route from scratch via browser automation. As long as reuse is cheaper than rediscovery, rational agents will prefer cached routes -- creating a positive-sum network effect where each new discovery benefits all future users.

This condition underpins the entire economic model: one-time install fees, per-execution fees, and per-query fees are all viable as long as they remain below the browser-based alternative cost.
