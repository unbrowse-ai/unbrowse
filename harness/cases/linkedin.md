# LinkedIn — Known Failure Case

## Problem
LinkedIn has the worst agent experience in the dataset: 34 browser opens, 69% resolve hit rate but 0% execute success. The agent finds the skill but can't execute it.

## Baseline Metrics
- Browser opens: 34 (highest of any domain)
- Resolve hit rate: 69%
- Execute success rate: 0%

## Common Intents
- "show my feed"
- "list job postings"
- "find connections"

## What to look for in screenshots
- Anti-bot wall: "We've detected unusual activity"
- Login gate (even with cookies)
- Empty feed state
- Connection required pages

## Known heuristics to check
- `executeEndpoint()` in execution/index.ts — why do found endpoints fail?
- Auth token injection — are LinkedIn cookies being used correctly?
- `buildDeferral()` — are the right endpoints being suggested?

## Fix targets
- H1: Execute success from 0% to 50%+ (auth wall detection + recovery)
- H2: Browser opens from 34 to under 10
- A2: Stale LinkedIn skills being cached (check domain cache TTL)
