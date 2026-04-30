# GitHub — Known Failure Case

## Problem
GitHub skills in the cache are stale — the cached skill doesn't match the current API structure. Agents keep getting wrong endpoints because the domain cache (7-day TTL) serves outdated skills.

## Baseline Metrics
- Stale skill matches: high
- Resolve hit rate: moderate (skill exists but wrong endpoints)
- Execute success rate: variable (depends on how far drifted the API is)

## Common Intents
- "list repositories"
- "find issues"
- "search code"

## Known heuristics to check
- `domainSkillCache` in orchestrator/index.ts — 7-day TTL may be too long
- `rankEndpoints()` — does staleness penalty correctly deprioritize old skills?
- `findExistingSkillForDomain()` in client/index.ts — does it check for newer versions?

## Fix targets
- A2: Stale skills cached without freshness check
- E1: Stale skills ranking high in results
- A6: Add `suggested_next_action` to stale skill errors
