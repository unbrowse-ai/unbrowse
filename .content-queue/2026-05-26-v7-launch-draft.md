# v7.0.0 launch — X post drafts

Per X-algo research (xai-org/x-algorithm Heavy Ranker weights: `reply_engaged_by_author=75.0` dominates everything; OON tax=0.75x; author-decay exponential within session). Strategy doc: `/tmp/x-strategy-doc.md`.

**Post strategy**: single banger root + structured reply chain. Do NOT post as a thread (author-decay compounds against you). Tuesday or Wednesday 8am PT. Reply to first 3-5 commenters within 2 minutes (the 75x weight).

---

## Root banger — image post

**Image**: screenshot of TypeScript with three diffs side-by-side, terminal-style:

```diff
- import { chromium } from 'playwright';
+ import { chromium } from '@unbrowse/playwright-shim';

- import Firecrawl from '@mendable/firecrawl-js';
+ import Firecrawl from '@unbrowse/firecrawl-shim';

- import { Stagehand } from '@browserbasehq/stagehand';
+ import { Stagehand } from '@unbrowse/stagehand-shim';
```

**Caption (text in the post itself, NO link in root)**:

> change one import line.
> your existing code pays $0 instead of per-browser-hour.
> cache hit → free synthesized response.
> miss → your existing api key still works.
>
> we ship v7 today.

(118 chars, well under 280, no link → first-reply will carry it.)

---

## First reply (carries the link)

> npm i @unbrowse/playwright-shim
> npm i @unbrowse/firecrawl-shim
> npm i @unbrowse/stagehand-shim
>
> docs + cost-comparison tables: unbrowse.ai/compare/playwright
> github: github.com/unbrowse-ai/unbrowse

---

## Reply 2 — the wedge (15-20 min after root)

> the wedge: every modern site already has internal APIs.
> playwright/firecrawl/stagehand work one layer too high — rendering full pages, parsing DOMs, clicking buttons that exist for human eyes.
>
> we capture those internal endpoints once. agents call them directly. 3.6× faster, 40× fewer tokens.
>
> peer-reviewed: arxiv.org/abs/2604.00694

---

## Reply 3 — the flywheel (30-40 min after root)

> the stickiness loop:
>
> every cache miss publishes the captured routes back to the marketplace under YOUR wallet. next call from any agent becomes a cache hit. you earn x402 micropayments when others use what you indexed.
>
> contribute once, get paid forever. like OSS dependencies but for web data.

---

## Reply 4 — the cost A/B (45-60 min after root)

Image: cost-comparison table from /compare/firecrawl

> the dollar math at 60% cache rate:
>
> Firecrawl Standard ($83/mo for 100k credits) → $33 via shim
> Browserbase Dev ($20/mo + $0.12/hr after 100hrs) → $0 on hits, your existing tier on miss
>
> break-even at 0% cache hit rate. anything above is direct savings.

---

## Quote-reply seeding (48h before launch — RealGraph buildup)

Reply to recent posts from these accounts with substantive comments (not "great post 🔥" — algo penalizes low-info engagement). Building RealGraph weight gets the 1.0→2.97× in-network boost:

- @anthropic (anything about agent tooling)
- @vercel (AI SDK or shipping news)
- @browserbasehq (Stagehand updates)
- @mendableai (Firecrawl posts)
- @cursor_ai (code-completion or model news)
- @ycombinator (Tuesday/Wednesday cohort posts)

Target: 8-12 substantive replies across these accounts in the 48h before launch.

---

## DM seeding (30 min before launch)

Send to 5-10 builders likely to share. Tone: technical, not promotional.

> hey, shipping a thing in 30 min you might find interesting — one-import drop-in shims for playwright/firecrawl/stagehand that route cache-first through our marketplace. existing code keeps working, cost goes to $0 on hits. would love your read if you're up.

Replace recipients with: (Lewis to fill — relevant @getFoundry / agent-builder DMs from his network).

---

## Anti-patterns to avoid (per Heavy Ranker)

- ❌ "RT if you ship to prod" — engagement-bait predicates downrank
- ❌ Multiple links in root — split predicates penalize
- ❌ Thread of 10 — author-decay (each subsequent tweet by you in the session has steeper exponential decay)
- ❌ All-caps hooks ("BREAKING:", "HUGE:") — Trust & Safety classifier flags
- ❌ Quote-RT chains > 3 levels deep — diminishing returns past depth 2
- ❌ Replying to your own root for the first 30 min — eats the 75x reply-engaged-by-author bonus

## Engagement playbook for first 30 min

The 75x weight: when YOU reply to a commenter and THEY reply back, that's the highest-value signal in the Heavy Ranker. So:

1. Watch the root for first 10 minutes
2. When the first 3-5 substantive replies land, reply within 2 minutes each
3. Phrase replies to invite a response: "what's the breakdown on YOUR existing playwright bill? curious if shim/no-shim makes a difference at your scale"
4. Each back-and-forth = ~150 like-equivalents in Heavy Ranker scoring

---

## When to fire

Tuesday or Wednesday, **8am PT / 11am ET / 4pm UK / 11pm SG**. Dev audience overlap is max here (US west wakes, US east mid-morning, UK afternoon).

Avoid: Monday (low engagement priors), Friday afternoon (everyone checks out), weekend (algo penalizes — fewer raters online to boost-or-bury).

---

## Honest caveats

- Oct 2025 Grok-replaces-Heavy-Ranker reporting has no open-source artifact. Weights cited above are Apr 2023 production README. Engagement-driving signals are likely similar (replies + author engagement dominate) but absolute multipliers may differ.
- "Observed patterns" from peer accounts is pattern-matched from public launches, not controlled. Adjust based on what we see in first 30 min.
- The DM seeding step needs Lewis to pick recipients — I won't autonomously DM unknown people in his name.
