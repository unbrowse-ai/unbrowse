# Unbrowse positioning (locked)

**Status:** product + marketing canon. Frontend, README, SKILL, MCP tool blurbs,
and public docs must agree. Last decided: 2026-08 (action layer, not browser category).

## Category (primary)

**Unbrowse is the route layer / action layer for AI agents on the web.**

It learns a site's first-party API routes from real browsing, then reuses those
routes on later calls so agents do not re-drive a browser for the same work.

### Locked headlines (pick one; do not invent a third category)

| Surface | Locked line |
|---|---|
| Homepage H1 | **The route layer for web agents.** |
| Meta / OG / one-liner | **Action layer for AI agents — first-party routes first, browser when needed.** |
| SKILL / agent docs | **Open-source action layer** that turns sites into reusable indexed routes |

### Locked mechanism (secondary — never the category)

- **API-first, browser when needed.** Cache hit → direct route. Miss / auth / pure UI → real browser.
- **Capture once, replay everywhere.** Shared sanitized route metadata; credentials stay local.

## Foil (what we replace)

Not "other browsers." The foil is:

> **Re-driving the DOM / headless browser on every agent turn** when the site
> already exposes a first-party route behind its UI.

Competitors of record for comparison pages: Playwright, Puppeteer, Firecrawl,
Browserbase/Stagehand — framed as *browser-first automation*, not as "worse browsers."

## Value vector (one testable superiority)

On a **known route**: structured result, no full page render, paper-measured
**3.6× mean / 5.4× median** speedup vs Playwright across 94 domains (warmed cache).
Do not invent 100× / 95% claims without a current gate.

## Banned as *category* claims

These may appear only as **historical foil** or compare-page language about
*competitors*, never as "Unbrowse is…":

| Banned | Why |
|---|---|
| "API-native browser" | Wrong shelf — Better Trap vs Playwright/Browserbase |
| "API-native browser agent" | Same |
| "the browser for AI agents" | Misstates the default path (route, not browser) |
| "default browser for AI agents" | Same |
| "better headless browser" | Better Trap |

Allowed: "browser fallback", "headless browser automation" (foil), "when a
browser is still required."

## Audience split

| Audience | Lead with | Not with |
|---|---|---|
| Agent builders | Intent → route → structured result | Browser features |
| Publishers / indexers | Earned USDC when routes are reused | Scraping volume |
| Site owners | Claim domain / fair split | "We scrape you" |

## Witness

```bash
bash scripts/positioning-gate.sh
```

Exit 0 only when active surfaces carry a locked category line and zero banned
category claims.
