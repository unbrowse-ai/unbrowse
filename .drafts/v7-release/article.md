# How we built unbrowse v7.0.0's release gate from 76 Reddit threads

Most agent-browser projects ship a number. unbrowse v7.0.0 ships the bench
that produced it, the corpus we built from real Reddit complaints, and the
payment rails that pay you when another agent reuses a route you indexed.
This is the methodology and what it found.

## The problem

If you have built anything on top of Playwright MCP, Browser Use, or a
similar agent-browser, you have felt the same three failures in different
shapes. The benchmark on the project's landing page passes, your real task
does not. The shadow APIs the page actually uses get hidden behind 2.4K
tokens of accessibility tree. A cold scrape on a hostile site eats ten
seconds of dwell and returns a Cloudflare interstitial as JSON.

Nobody benches for those failures because nobody wants to. The honest test
of an agent browser is not "can it open google.com". It is "can it search
PubMed for cancer immunotherapy papers and return actual results, not
twenty query completions". It is "can it pull r/singularity comments
without the ranker picking the wrong template and getting r/programming
instead". It is "can it list product cards on a SPA whose initial state
is an empty entity bag".

So we built the bench you would actually want to run, and we cut a
release that has to pass it.

## The approach

We sourced the corpus from people complaining on Reddit instead of
guessing intents in a meeting. The probes are typed declarations, not
regex strings. The judgment is an agent reading the artifact in-thread,
not a grep against a status code. Every fix that lands has to flip
exactly one probe from fail to pass without breaking the others.

This is the inverse of the standard release ritual. Most teams write a
release note, then write a marketing post, then hope the next batch of
issues stays small. We write the corpus first, then make the corpus
pass, then write the release note from the diff. The benchmark is the
contract; the prose is downstream of it.

## Step 1: Pull the corpus from Reddit

Two evidence-build waves over twelve subreddits, sixteen query pairs,
seventy-six unique threads. The subreddits picked themselves:
r/LocalLLaMA, r/AI_Agents, r/mcp, r/LangChain, r/AskProgramming,
r/webdev, r/scraping, r/selfhosted, r/n8n, r/Anthropic, r/ChatGPT,
r/singularity. The queries were intents shaped like "agents that can
log into my own accounts", "why does Playwright MCP eat 100K tokens",
"anti-bot bypass that actually works", "MCP server that charges per
call".

Each thread produced one or more concrete pains in the user's own
voice. Those pains became the lanes the landing page now answers and
the probes the release gate now tests. Every claim on our landing page
has a `t3_` thread id next to it. Every probe in the corpus has a
typed intent and an anchor URL.

The full trace lives at `frontend/docs/POSITIONING.md` in the repo.

## Step 2: Type every probe; never bench against a prose intent

A probe looks like this in `harness/probes/corpus-gate.txt`:

```
intent|context_url|lane|probe_id
search pubmed for cancer immunotherapy papers|https://pubmed.ncbi.nlm.nih.gov/|public|030
get reddit r/singularity hot|https://www.reddit.com/r/singularity/|public|012
list dockerhub nginx tags|https://hub.docker.com/_/nginx/tags|public|010
```

Lanes are declared (public, anchor, hostile, auth-gated). The probe id
maps to a row in `bench-gate-baseline.json`. The runner is
`scripts/mcp-gate-parallel-collect.ts`, which drives the real
`unbrowse_resolve` and `unbrowse_execute` calls through MCP, not a
curl shortcut.

The corpus is open. The methodology to grow it is open. If a
competitor wants to game our number, they have to game ours, not
invent their own favorable harness.

## Step 3: The agent judges, not the harness

The hardest discipline in this build was refusing to let the harness
pick a verdict. The release-gate judge is a separate document,
`harness/probes/GATE_JUDGE.md`, that an agent reads alongside each
probe's artifact bundle: resolve shortlist, pick, execute response,
captured page snapshot. The harness never decides "this is a pass".
It only writes the evidence the judge will read.

We learned this the hard way. An earlier version classified "HTTP 200"
as `RETRIEVE_PASS`. Half those passes were Akamai bot-management
interstitials returning 200 with a `Pardon Our Interruption` body. The
verdict looked great; the agent got nothing. A response with `status:
200` and `data: []` is not a pass. An Akamai interstitial under HTTP
200 is not a pass. The agent has to look at the body and decide.

Three things made this tractable. First, the judge document is short
enough to fit in context (rubric plus six lane-specific clauses).
Second, the artifact bundle per probe is bounded (around 32KB of pick
plus shortlist plus response). Third, the judge runs over `claude -p`
in the background, not an Anthropic SDK call from the harness, so
there is no local model state to drift.

## Step 4: Every fix is gated by exactly one probe

The release loop has one rule: a fix lands when it flips exactly one
probe from fail to pass and does not regress any other probe. Last
week alone the loop produced about forty of these:

```
W4-followup-3 LIST_INTENT page-artifact needs list-shaped schema (#553)
W-AKAMAI-BM-VERIFY-BROWSER-FALLBACK server auto-routes to browser (#554)
W-STALE-ENDPOINT-PAGE-FALLBACK 401/403 SSR fastpath before stale envelope (#550)
W-NOISE-FILTER-CONTROLLER-RESOURCES drop JS module-loader bootstraps (#551)
W6 detect Akamai interstitial in JSON-extracted bodies (#540)
```

Each commit message names the probe it flips. Each fix is a structural
primitive, not a per-domain heuristic. The probe that surfaced the bug
becomes the regression test that prevents it coming back.

The substrate principle is load-bearing here. We do not ship "if host
== ebay.com then route to browser". We ship "if `serverFetch`
returned 200 with a body the vendor-pattern detector classifies as a
known bot-management interstitial, route to browser". The detector
reads shape; it never reads a host registry. Every fix gets that
one-layer-up treatment before it lands. Per-host rules are taxes the
team pays forever; structural primitives compound.

## Step 5: Move the intelligence server-side

The bench did something we did not expect: it showed us where the moat
actually was. The ranker, the LLM augmentation of captured endpoints,
the edge-confidence weights on the DAG of routes, the reliability
scoring across users. All of those were running client-side in the
npm bundle, which meant the tuning weights were reverse-engineerable
and a forked client could replay our intelligence with its own brand
on top.

So v7.0.0 moves four pieces of intelligence to the server, behind
authed routes:

- `POST /v1/search/rank` runs the 900-line evidence-derived ranker
  server-side; the client gets candidates plus per-signal evidence,
  never the weight table.
- `POST /v1/graph/augment-semantic` runs the LLM augmentation prompt
  server-side; the client posts a sanitized endpoint skeleton, the
  server returns enriched metadata. Swapping models no longer
  requires a client release.
- `POST /v1/graph/confidence` runs cross-user online-learned edge
  weights for the DAG of operations; clients see only the projection
  for the edges they ask about, never the per-edge counters.
- `POST /v1/stats/reflect` runs the population-level reliability and
  staleness aggregate; the client adopts the authoritative score for
  the local snapshot.

Each route has a degraded local fallback so an offline resolve still
works, but the cross-user signal stays where it can only be learned
from cross-user data. A forked client cannot reconstruct what it never
sees.

## Step 6: Pay the agent that uses your route

This is the part that pairs the bench with the payment subsidy.

v7.0.0 makes paid execution the default path with three working rails
layered over a Faremeter Flex settlement seam on Solana USDC. The
settlement chain matters because previous drafts of this story put us
on Base L2; the codebase shows `backend/src/services/sponsor-flex.ts`
calling Solana RPC and `backend/src/middleware/sponsor.ts` running the
Faremeter Flex rail. The wave-3 audit corrected the public copy.

The three rails:

1. **Sponsor middleware (the subsidy).** Every paid execute first
   checks a per-agent signup budget and a per-platform daily safety
   cap. The platform wallet sponsors the first $1 of execution for
   every new agent on signup; once that dollar is spent the agent
   falls through to its own x402 wallet. A platform-wide $50/day cap
   sits on top as a runaway guard. State lives in KV:
   `sponsor:agent:<id>:<UTC-date>`, `sponsor:global:<UTC-date>`,
   `sponsor:ledger:<id>`. Surfaced via
   `GET /v1/account/sponsor-status` and
   `GET /v1/admin/sponsor-ledger`. A new agent's first dollar of
   execution is on us; no x402 wallet needed for it.

2. **Opt-in paid residential-proxy fallback on 429.** When the local
   execute path detects an HTTP 429 on a target, the agent can opt in
   to a residential proxy hop priced around one cent per call, billed
   server-side via x402. Egress stays local because Cloudflare Workers
   cannot CONNECT-tunnel through an arbitrary residential proxy;
   billing sits where the meter lives. The default behavior is still
   off; the agent or operator opts in.

3. **LLM gateway with 50% markup.** `POST /v1/llm/:provider/messages`
   accepts a Stripe x402 envelope, proxies to xgate.run, and bills
   50% above raw provider cost. The unbrowse account becomes a
   unified payment surface for the agent's whole stack: the same key
   that pays for a paid route on resolve also pays for the Anthropic
   or OpenAI call upstream of it. This rail is the lever that lets us
   subsidize the first dollar on the execute side without losing on
   it; the margin on the gateway covers the subsidy.

The marketplace cut stays at 10%. The new structure means an agent
can mine a route on a paid site, publish it to the marketplace, and
earn the per-execute fee every time another agent reuses it. The
lobster.cash wallet binding (set up during `npx unbrowse setup`) pays
out without you holding the Solana keys.

## Step 7: Open the bench so the next person can grow it

`harness/probes/corpus-gate.txt` is in the repo.
`harness/probes/GATE_JUDGE.md` is in the repo. A new
`docs/BENCHMARK.md` (shipping with v7.0.0) walks the
reddit-to-corpus methodology, the typed-probe contract, the lane
taxonomy, and the agent-judges-not-regex discipline. An outside
maintainer can fork the corpus, run the gate locally, and propose a
row via PR.

There is one constraint. The corpus must stay typed and lane-tagged;
an untyped probe is not a probe, it is a wish. The PR template walks
the contributor through declaring intent, anchor URL, lane, and
expected pass shape before the row lands.

## Results

What the v7.0.0 release looks like in numbers we can stand behind:

- 58 probes in the locked corpus; 66 in the running superset.
- 4 server-authoritative intelligence routes; client-side fallbacks
  all green.
- 3 payment rails working: sponsor cap, residential proxy on 429, LLM
  gateway with 50% markup.
- 1 settlement rail: Faremeter Flex over Solana USDC. The wallet
  delegation boundary is in `/how-unbrowse-pays`: unbrowse owns
  intent, amount, recipient, memo; lobster.cash owns provisioning,
  signing, broadcast.
- Last seven days: roughly forty probe-gated fixes landed, each
  naming the one probe it flips.

The paper benchmark numbers (3.6x mean speedup, 5.4x median over
Playwright across 94 live domains) still hold from the arXiv
submission and are not new in v7.0.0. The new number that matters is
bench-gate pass rate per lane, and we are publishing it with the
release.

## What we would do differently

Three honest things.

We spent three weeks before realizing the harness was deciding
verdicts when it should have only collected evidence. The Akamai-200
misclassification masked a whole class of failures. Burn the "harness
emits a verdict" instinct out of your team early; it always comes
back.

We tried to keep a per-domain hint registry alive longer than we
should have. Sixteen sites of site-specific replay logic became
sixteen taxes the team paid every week. We deleted the registry in
the v6 line and shipped the structural primitives that subsumed it;
the codebase is shorter and the bench is greener. If you are about
to write `if host == X`, write the structural detector instead.

We pivoted the payment rail from Cascade to Faremeter Flex partway
through v6.16 development. The pivot cost about a week. The trigger
was realizing Cascade did not let us cleanly split the settlement
seam from provisioning and signing, and the wallet delegation
boundary was the load-bearing piece of trust the customer needed.
Flex made that boundary explicit. We should have argued the boundary
first and picked the rail second.

## Try it now

```bash
npx unbrowse setup
unbrowse resolve "search pubmed for cancer immunotherapy papers"
```

The first call is free per the sponsor tier. The shortlist that
comes back is ranked server-side by the v7.0.0 ranker; the pick is
yours. If you publish a new route from your own session, the next
agent that uses it pays you in USDC on Solana.

The corpus is at `harness/probes/corpus-gate.txt` in the repo. The
judge rubric is at `harness/probes/GATE_JUDGE.md`. The bench is the
contract.
