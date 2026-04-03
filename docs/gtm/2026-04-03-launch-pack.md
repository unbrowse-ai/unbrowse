# GTM Launch Pack — 2026-04-03

## Live Signals

- GitHub repo: `612` stars, `57` forks, `21` open issues. Last updated `2026-04-02T21:55:10Z`.
- npm: `4,776` downloads last month for `unbrowse` (`2026-03-03` to `2026-04-01`).
- Public stats summary now reports: `239` skills, `10,997` endpoints, `160` domains, `722` executions, `103` agents, marketplace hit rate `75%`, avg resolve `5.3s`, p95 `23.1s`.
- Traction surface now reports: `99,768` verifications, `195` WAU, `831` total keys, `45%` weekly retention, `5,420` combined npm downloads.
- Hacker News front page appetite is strong for AI/dev infra right now:
  - `Gemma 4 open models` at `1107 points`
  - `Cursor 3` at `272 points`
  - `Qwen3.6-Plus: Towards real world agents` at `421 points`
- X duplicate scan on `@unbrowse`: recent posts already used the paper-drop, browser-tax, speedup, and cost-reduction hooks. New posts should pivot to network scale and compounding route reuse.

## Read

- GitHub and npm are inching up versus sprint baselines (`608` stars, `4,734` npm).
- Public proof is now good enough to lead with network scale instead of only thesis and benchmark.
- HN timing is good for an infra launch. AI/tooling stories are getting real distribution today.

## Priority Order

1. Ship `Show HN` with proof, benchmark, paper, and live network stats in the first comment.
2. Queue an X thread the same day as HN, but avoid repeating the existing paper / speedup hooks.
3. Use Reddit as follow-on distribution, not the lead channel.
4. Send investor and stargazer updates once the launch is live and can anchor on fresh social proof.
5. Recheck the public counters after launch day and turn deltas into the next investor update.

## Show HN

### Primary title

`Show HN: Unbrowse — a browser for agents that turns websites into reusable APIs`

### Backup titles

- `Show HN: Unbrowse — stop turning JSON into pixels back into JSON`
- `Show HN: Unbrowse — agent-native browser that learns site APIs from real traffic`

### First comment draft

Built this because browser agents keep paying the browser tax:

- page render
- screenshot / DOM parse
- LLM extraction
- repeat on the next run

Unbrowse takes the opposite path. It watches real browsing traffic, learns the internal API routes, then replays those routes directly on the next call.

Proof points:

- 94-domain benchmark
- 3.6x mean speedup, 5.4x median
- 100% win rate vs Playwright on the benchmark set
- 239 skills / 10,997 endpoints / 160 domains in the live network
- 103 agents and 75% cache-or-marketplace hit rate on the public summary
- GitHub repo now at 612 stars
- npm package at 4,776 monthly downloads

Paper: https://arxiv.org/abs/2604.00694

Happy to answer about capture, auth, route replay, or where this still fails.

### HN comment handling

- Reply fast on: auth, anti-bot, GraphQL POSTs, why not Playwright, benchmark methodology.
- Lead with honesty on weak spots: long-tail cold start, WAF churn, GraphQL mutation complexity.
- Keep returning to the category line: `drop-in browser for agents`.

## X Thread

### Hook

`103 agents have already mapped 160 domains into 10,997 callable routes. That's the real moat for agent web tooling.`

### Thread

1. 103 agents have already mapped 160 domains into 10,997 callable routes. That's the real moat for agent web tooling.
2. The first browser run should not die as exhaust. It should become reusable infrastructure.
3. That's what Unbrowse does: browse once, capture the traffic, learn the internal API routes, replay them directly next time.
4. The live public summary is now at 239 skills, 10,997 endpoints, 722 executions, 103 agents.
5. And 75% of resolves are already hitting cache or marketplace instead of paying full browser cost.
6. On the benchmark side: 94 domains, 3.6x mean speedup, 5.4x median, 100% win rate vs Playwright.
7. Repo is at 612 stars. npm is at 4,776 monthly downloads. Paper is here: https://arxiv.org/abs/2604.00694
8. If you build agents that revisit the same sites, the right question is not "which browser?" It's "why are we still re-rendering known routes?"

### Media order

1. benchmark chart
2. route-learning diagram
3. short CLI demo or before/after GIF

## Reddit

### r/ClaudeAI

I built an agent-native browser because screenshot browsers keep paying the same tax over and over.

Unbrowse watches real browsing traffic, learns the site's internal API routes, then reuses those routes on the next run instead of rendering the page again.

The benchmark across 94 domains came out 3.6x faster on average vs Playwright, with a live paper here: https://arxiv.org/abs/2604.00694

The interesting part is not "browser automation but cheaper". It's that the first browse creates a reusable asset for every later run.

Curious where people think this breaks in real agent stacks.

### r/webdev

Built a tool around a simple idea: most websites already expose the data agents want through internal APIs, but browser tooling forces the slow path anyway.

So instead of treating the browser as the product, Unbrowse treats it as the discovery phase:

- browse once
- capture traffic
- infer the route + params
- replay the route directly next time

Would love feedback from people who have fought with auth, WAFs, or GraphQL-heavy apps.

## Investor Update Blurb

Public proof points moved again today:

- GitHub repo at 612 stars
- npm at 4,776 monthly downloads
- public network summary at 239 skills / 10,997 endpoints / 160 domains / 103 agents
- traction surface at 99,768 verifications / 195 WAU / 831 keys / 45% weekly retention
- paper live on arXiv
- HN/X launch pack ready

Main blocker is no longer public stats truth. The next blocker is execution: get the HN launch and a non-duplicative X thread out while these numbers are fresh.

## Next Run

1. Re-check `beta-api` summary and traction truth.
2. Pull Typefully queue and compare to this pack.
3. If queue is empty, post the fresh network-scale X angle instead of another paper hook.
4. Draft investor update off the new public numbers the same day as launch.
