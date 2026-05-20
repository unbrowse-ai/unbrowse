# Bench corpus refresh — self-feeding from real-world pain

The bench-gate corpus (`harness/probes/corpus-gate.txt`) only catches
regressions on sites it actually contains. If a category of failure
shows up in the wild and isn't in the corpus, the gate is silent. To
keep the corpus honest we mine real-world reports of "hard to scrape"
sites and propose additions.

This is **agent-driven, not automated**. The refresh script *proposes*;
the agent reviews, deduplicates, classifies, and commits. The corpus
remains committed truth — never auto-mutated.

## What we mine

| Source | What we look for |
|--------|------------------|
| `r/webscraping` (Reddit) | "how do I scrape X", "X blocks my bot", "X anti-bot" |
| `r/programming` (Reddit) | scraping/reverse-engineer war stories |
| HN search: `scraper`, `playwright`, `puppeteer`, `cloudflare bypass` | engineering pain points |
| GitHub issues across `playwright`, `puppeteer`, `scrapy`, `crawlee`, `colly`, `crawl4ai` | reproducer URLs |
| Our own `feedback` table (`/v1/feedback/raw`) | sites users reported failing in unbrowse itself |

## Difficulty signals we tag

When a site appears in mined content, the agent tags it with one or more:

- `vendor:cloudflare-turnstile` / `datadome` / `perimeterx` / `akamai` / `imperva` / `kasada` / `shape` — anti-bot
- `graphql-post-operationname` — POST + `operationName` body extraction (X timeline, LinkedIn feed)
- `ssr-only` — page IS the data; no XHR
- `auth-wall-must-handoff` — gated content; success = `next_step: open_browse_session`
- `semantic-rank-substitution` — same template, different entity (subreddit, repo, listing)
- `spa-payload-extraction` — Next.js JSON in `<script>`, Apollo Cache, Nuxt payload
- `websocket-only` — data only flows over WS
- `captcha-interstitial` — h-captcha / reCAPTCHA before content
- `pagination-cursor` — opaque cursor tokens, no offset
- `dynamic-rate-limit` — server-adjusted rate-limit headers requiring backoff

Each lane in the corpus maps to a difficulty bucket:
- `anchor` — must-pass (no difficulty signals; if these break the gate is broken)
- `semantic-rank` — `semantic-rank-substitution`
- `graphql` — `graphql-post-operationname`
- `ssr-list` — `ssr-only` + `spa-payload-extraction`
- `auth-gated` — `auth-wall-must-handoff`
- `hostile` — any `vendor:*` or `captcha-interstitial`

## The refresh script

`scripts/refresh-bench-corpus.sh` runs the discovery loop:

```bash
#!/usr/bin/env bash
# 1. Capture each source URL via unbrowse (reuse our own pipeline)
# 2. Extract candidate site URLs from post bodies + comments
# 3. Write candidates with provenance (source post URL + excerpted quote)
#    to .bench-gate/refresh/<run-id>/candidates.json
# 4. Stop. Agent reviews candidates, classifies by lane, dedupes against
#    existing corpus, and opens a PR adding new probes.
```

The agent does:
1. Read `candidates.json`
2. For each candidate site:
   - Skip if already in `corpus-gate.txt`
   - Determine lane from difficulty signals + manual judgment
   - Construct an intent that exercises the failure mode
   - Append `lane | intent | URL` to the corpus
3. Open a PR: "corpus: add N field-reported probes from <date> refresh"
4. Re-run the bench-gate against the new corpus, judge, stamp

## Cadence

- **Monthly**: agent runs refresh, reviews candidates, lands any new probes
- **On user report**: if a user lodges 2+ feedback events for the same site,
  the refresh script flags it for the next cycle (or earlier if it looks
  like a regression in our pipeline)
- **Never auto-mutate the corpus**: every addition lands in a reviewed PR

## Mining sources today (provenance)

The initial 50-probe corpus drew from:
- Production usage at `getFoundry` / `unbrowse` accounts (X, GitHub, npm, etc.)
- Known A8 regression cases (Reddit r/X, GitHub /owner/repo)
- Anti-bot vendor showcase sites (Ticketmaster, Nike, StockX — all confirmed-hostile)
- Auth-wall reference cases (Gmail, Notion, Slack)

The refresh extends this with field-reported pain. The corpus file
itself stores the lane and intent; provenance lives in the PR
description and the `.bench-gate/refresh/<run-id>/candidates.json`
record that prompted each addition.

## Why not auto-merge

Two reasons:
1. **Trust**: a probe added to the corpus is a future-self-binding
   commitment that "this site MUST pass". Adding a site we can't reliably
   pass turns the gate into a forever-red badge.
2. **Hostile-lane discipline**: a hostile-lane probe that suddenly starts
   passing is a yellow flag (anti-bot honey-trap). The agent has to
   *intend* to add a hostile probe and accept the suspicion-on-PASS
   semantics. Auto-merge would skip that intent.

## Connection to A8 + page-artifact regression tests

The corpus is not just "failures" — it pins specific historical fixes:
- `semantic-rank | get singularity subreddit posts | https://www.reddit.com/r/singularity/` — A8 entity substitution
- `ssr-list | search amazon for usb-c cables | https://www.amazon.com/s?k=usb-c+cable` — page-artifact promotion for LIST_INTENT
- `graphql | get home timeline | https://x.com/home` — X timeline POST + operationName

When we add new probes from the refresh, the same principle applies:
each probe IS a regression-pin for a specific behavior we want to keep.
