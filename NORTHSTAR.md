# NORTHSTAR.md

## The single sentence

> **Every browser session an agent runs becomes a reusable Unbrowse skill, autonomously, with no capture step the agent or user has to think about.**

Kuri is the discovery engine. Unbrowse is the index and execution layer. The marketplace is the moat. The agent only ever calls `resolve` → `execute`. Everything else is plumbing that should disappear.

---

## What the docs already say (synthesized)

Reading across `CLAUDE.md`, `SKILL.md`, `README.md`, `AGENTS.md`, `OPENCLAW_AGENT_BROWSER_PRODUCT_SPEC.md`, and `newskillunbrowse.md`, the same vision shows up four different ways:

1. **CLAUDE.md (Agent UX North Star)** — two-tool contract (resolve → execute), fewer errors, correct retrieval per entity, works-for-what-was-asked. *Browser-open is a failure mode, not a feature.* Stickiness comes from being the default browser via plugin + MCP, so every agent web task routes through us automatically.

2. **CLAUDE.md (Architecture)** — Kuri is the primary browser, headless on every platform, with passive HAR + JS interceptor capture running on every session. Capture pipeline is *the same* for passive and explicit: `extractEndpoints → extractAuthHeaders → storeCredential → mergeEndpoints → generateLocalDescription → augmentEndpointsWithAgent → buildSkillOperationGraph → cachePublishedSkill → queueBackgroundIndex`. Marketplace publish is asynchronous; resolve falls through cache → marketplace → first-pass browser → live capture.

3. **SKILL.md (Three execution paths)** — skill cache <200ms, shared marketplace sub-second, live browser 20–80s. Path 3 is where capture happens, and it indexes for everyone else's Path 1 and Path 2. The flywheel is: every Path 3 someone runs makes the next agent's request a Path 1 or Path 2.

4. **OPENCLAW_AGENT_BROWSER_PRODUCT_SPEC.md (Original vision)** — discovery and learning happen *through agent-browser* (not a plugin, not a manual capture command); reverse-engineering and verification publish merged endpoints to a public marketplace; user credentials stay local; "if no match: perform live browse, capture HAR, reverse engineer, validate, publish, execute" — *all of this without the user composing it as separate steps.*

**The thread that ties all four:** the user/agent does normal work in a browser, and the marketplace silently fills with high-quality skills. Capture is invisible. Publish is automatic. Resolution is the only surface.

## The autonomy gap (what reality looks like today)

The mental model in the docs has not been fully delivered. Five concrete gaps, in order of how much they cost the flywheel:

1. **Single-browser monopoly is unenforced.**
   Kuri only learns from Kuri sessions. Traffic that an agent generates through `chrome-devtools` MCP, Playwright, Puppeteer, the user's own logged-in Chrome, or any other browser MCP is invisible to Unbrowse. Today's session is the canonical example: the agent drove jmail.world through `chrome-devtools`, then `unbrowse resolve` had nothing — because Unbrowse never saw the traffic. The richest data source (the user's authenticated Chrome) is the largest hole.

2. **Capture is checkpointed, not streaming.**
   Routes captured during a session don't surface in the marketplace until `close` or `sync` triggers `queueBackgroundIndex`. The current SKILL.md workflow even *mandates* close → review → publish as discrete steps. That gates cross-agent reuse on a manual handoff. The same agent in the same session can't take advantage of routes it just captured ten seconds ago.

3. **Resolve doesn't consult the in-flight capture buffer.**
   Resolve ladder is cache → marketplace → first-pass browser (8s timeout) → live capture. It doesn't look at the just-captured-but-not-yet-published routes for the same domain in the active session. Result: agents loop through repeated live captures of routes Unbrowse already has in memory.

4. **Per-domain heuristics keep growing back.**
   `CLAUDE.md` calls per-host registries banned, but the temptation reappears every time capture is incomplete. The pattern is always: a site doesn't extract well → someone adds `if (host === "x.com") …` → 11th similar site silently breaks. The only durable fix is upstream — read the SSR payload, the embedded JSON, `<link rel="alternate">`, sitemap.xml, OpenSearch descriptors, JS heap state. Heuristics are debt; primitives are leverage.

5. **Stale skills rank high.**
   Auto-deprecation by failure rate is in the spec but not in production. Every site change degrades the index, and ranking is not aware. Agents trust ghosts.

## The single-browser monopoly is the load-bearing fix

Of the five gaps, #1 is the one that makes the others tractable. If every browser an agent touches feeds the same capture pipeline, then:

- Streaming publish becomes valuable (more events to stream).
- Resolve consulting in-flight capture becomes meaningful (more in-flight capture to consult).
- Per-domain heuristics get starved of demand (because the upstream data is now reliably present).
- Stale-skill detection has more signal (more execution attempts per route).

The implementation shape: a CDP-attach mode where Unbrowse hooks any Chrome instance with a debug port — including ones started by other MCP servers, ones started by the user, ones started by Playwright/Puppeteer — and runs the same interceptor + HAR + enrichment pipeline as native Kuri sessions. Browser identity stops mattering. The agent doesn't have to know which browser is being driven; capture is universal.

This is what the CLAUDE.md "stickiness strategy" ("make Unbrowse the default browser for every agent via plugin + MCP") was always pointing at. Plugin + MCP is the install path; CDP-attach is the runtime mechanism that makes the install actually load-bearing.

## The two-tool contract (re-anchored)

Every other tool in the surface area exists *because* something in the autonomy chain isn't yet automatic:

| Tool | Why it exists today | What removes it |
|---|---|---|
| `go` | Resolve doesn't auto-open a browser when capture is needed | Resolve handles browse-session lifecycle internally |
| `snap`/`click`/`fill`/`type`/`press`/`select`/`scroll` | Agent has to drive UI when Kuri can't auto-replay | Better DOM-fallback + structural extractors → fewer manual UI drives |
| `close`/`sync` | Publish is checkpointed | Streaming background publish |
| `index` | Index runs on demand | Always-on indexer |
| `login` | Auth chain not autonomous | `sessions-scan` + cookie injection + OTP read fully chained |
| `feedback` | We don't auto-detect bad executions | Auto-deprecate on failure-rate signal |

Each of these is a feature *and* a tax. The feature lets agents work today. The tax is they leak the abstraction — the agent has to know the pipeline exists. Every release should be deleting one of these tools or making it never-needed.

The destination: an agent installs Unbrowse, sets `UNBROWSE` as its browser, and only ever calls `resolve(intent, url)` → `execute(endpoint_id, params)`. Nothing else.

## The flywheel (with autonomy as the engine)

```
Agent does real web work
        │
        ▼   (any browser, captured via CDP-attach)
Kuri / attached Chrome runs the work
        │
        ▼   (always-on, passive, silent)
Capture pipeline — HAR + interceptor + DOM
        │
        ▼   (streaming, not checkpointed)
Enrichment — extract → auth → merge → describe → augment → graph → cache
        │
        ▼   (continuous background publish)
Marketplace — versioned, deduped, ranked, deprecated
        │
        ▼   (resolve picks best path)
Next agent: cache hit (Path 1) or marketplace hit (Path 2)
        │
        ▼
30x faster, 90% cheaper than another browser session
        │
        ▼   (x402 mining)
Contributing wallet earns
        │
        ▼
Compounding supply for every domain anyone touches
```

The monetary layer (x402, mining) is the *incentive*, but the *engine* is invisible learning. If users have to think about contributing — `unbrowse capture`, `unbrowse publish`, `unbrowse index`, "open a session to teach it" — the engine is broken regardless of how the incentives are tuned.

## Tests for whether a feature is on the North Star

Before shipping, every change answers five questions:

1. **Does this reduce the number of explicit steps an agent or user takes?** *(Want: yes.)*
2. **Does this widen the set of browser sessions Unbrowse learns from?** *(Want: yes.)*
3. **Does this shrink the time between "request was made in a browser" and "skill is callable from anywhere"?** *(Want: yes.)*
4. **Does this require the agent to know that learning exists?** *(Want: no.)*
5. **Does this add a per-domain heuristic?** *(Want: no — every shortcut is debt the 11th site collects.)*

If any answer goes the wrong way, the feature is off the path even if it ships traction. *Especially* if it ships traction — because growth on a leaky foundation is harder to undo than slow growth on a sound one.

## What this is *not*

- Not a prompt-the-agent-to-explore loop. Discovery is a side effect of real work, not a synthetic crawl.
- Not "we'll capture the homepage and call it indexed." The unit is the endpoint behind a real intent, with real auth, real params, real response.
- Not opt-in per session. Capture is always on; the only opt-out is at install time.
- Not a UI feature. There's no "discoveries" tab the user reviews. The marketplace is the only surface.
- Not heuristic registries. Site-specific shortcuts are a sign capture is incomplete upstream.

## What "done" looks like

A user installs Unbrowse once. Their agent goes about its life — driving Kuri, driving the user's logged-in Chrome via CDP-attach, driving whatever browser anything else hands it. They never run a capture command. They never see a session UI. Six months later, the marketplace knows their long tail of personal SaaS, internal tools, and weird sites better than any public corpus, because every browser session anyone ever ran was indexed silently.

When *another* agent — anywhere — needs the same intent on the same site, it resolves in milliseconds against a route the first user's mining contributed.

That's the North Star. Every PR either reduces an explicit step or closes a capture hole. If it doesn't, it's not on the path.
