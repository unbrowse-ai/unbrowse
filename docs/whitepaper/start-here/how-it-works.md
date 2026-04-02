# How It Works

The best way to understand Unbrowse is to follow a single request through the system. We will use a concrete example: an agent that needs the top stories from Hacker News.

## The Request

An agent issues a single command:

```
unbrowse resolve --intent "top stories" --url "https://news.ycombinator.com" --execute
```

This is the only thing the agent needs to do. Everything below happens inside Unbrowse.

## Step 1: Check the Local Cache

The orchestrator first checks the local route cache on the agent's machine. This cache contains skill manifests from previous interactions -- endpoints that this agent (or this machine) has already used successfully.

If the agent has resolved Hacker News before, the cached route is found immediately. Execution skips ahead to Step 5. The whole round trip takes under 100 milliseconds.

On first use, the cache is empty. The orchestrator moves to the next path.

## Step 2: Search the Shared Marketplace

The orchestrator queries the Unbrowse marketplace -- a shared index of skill manifests contributed by agents across the network. The search combines the intent ("top stories") with the target domain ("news.ycombinator.com") to find relevant skills.

In this case, another agent discovered Hacker News weeks ago. The marketplace returns a skill manifest containing two endpoints:

- `GET https://hacker-news.firebaseio.com/v0/topstories.json` -- returns an array of story IDs for the front page
- `GET https://hacker-news.firebaseio.com/v0/newstories.json` -- returns an array of story IDs for the newest submissions

Each endpoint comes with its URL template, expected response schema, reliability score, last verification timestamp, and a natural-language description of what it returns.

## Step 3: Rank and Select

The orchestrator does not blindly pick the first result. As described in Section 4 of the paper, endpoints are ranked by a composite score that weighs four factors:

- **Semantic match (40%)** -- how well does the endpoint's description match the agent's intent? "Top stories" maps strongly to the front-page endpoint, weakly to the newest endpoint.
- **Reliability (30%)** -- what is this endpoint's historical success rate? An endpoint that returns valid data 98% of the time ranks higher than one that intermittently fails.
- **Freshness (15%)** -- when was this endpoint last verified working? An endpoint confirmed yesterday ranks higher than one last checked three months ago.
- **Verification state (15%)** -- has this endpoint been independently verified, or is it based on a single unconfirmed capture?

The front-page endpoint scores highest. The orchestrator selects it for execution.

## Step 4: Execute

Because the `--execute` flag was passed, the orchestrator calls the selected endpoint directly. This is a simple HTTP GET request -- no browser, no page rendering, no DOM inspection.

The endpoint returns an array of story IDs. Unbrowse hydrates each ID by fetching the corresponding item endpoint (`/v0/item/{id}.json`), assembling 30 structured items with titles, URLs, scores, and comment counts.

Total time from marketplace lookup to structured result: under 1 second.

## Step 5: Cache Locally

The successful result is cached on the agent's machine. The skill manifest is stored locally with the reliability score incremented. The next time this agent (or any agent on this machine) asks for Hacker News top stories, it hits the local cache and completes in under 100 milliseconds.

## What If No Skill Existed?

The example above assumed another agent had already discovered Hacker News. But what happens on a site nobody has indexed yet?

This is where the browser fallback path activates -- the third path in the three-path model described in Section 3 of the paper.

**Launch the browser.** Unbrowse starts a Kuri-managed browser session with the target URL. Kuri loads the page in a real Chrome instance with anti-detection extensions and the user's existing cookies (extracted from their local browser profile).

**Capture traffic passively.** While the page loads, Unbrowse records all network traffic between the browser and the site's backend. A fetch/XHR interceptor running in the page context catches requests that CDP-level HAR recording might miss, particularly on single-page applications.

**Reverse-engineer endpoints.** The captured traffic goes through the enrichment pipeline: endpoint extraction, auth header identification, credential storage, and LLM-assisted semantic annotation. The pipeline identifies which requests are data-carrying API calls versus static asset loads, and generates natural-language descriptions of what each endpoint does.

**Execute the task.** The best candidate endpoint is selected from the freshly discovered set and used to fulfill the agent's original intent.

**Publish to the marketplace.** The new skill manifest -- with all its endpoints, schemas, and metadata -- is published to the shared marketplace. The next agent that needs this site gets the fast path.

This is the flywheel described in the paper. Every browser fallback is an investment. The shared graph grows with usage, and the probability of needing a browser fallback decreases over time.

## The Economic Logic

The paper formalizes a simple cost inequality (Section 5): use the shared route graph when the cost of a lookup is less than the cost of rediscovery.

In practice, this means:

- A marketplace lookup costs roughly 1 second and a few kilobytes of bandwidth
- A browser-based rediscovery costs 8-30 seconds, browser compute, and LLM inference for endpoint annotation
- The shared path wins overwhelmingly for any site that has been discovered at least once

Across the 94-domain benchmark, the shared path produced a 3.6x mean speedup. For frequently accessed sites with stable APIs, the local cache path produced speedups exceeding 30x.

## Read Next

* [Mental Models](mental-models.md) -- intuitive analogies for the system
* [What Is Unbrowse?](what-is-unbrowse.md) -- the conceptual overview
* [The Problem](the-problem.md) -- why this architecture exists
