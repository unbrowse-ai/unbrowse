# X.com Timeline — Known Failure Case

## Problem
X.com (Twitter) uses class-based CSS selectors and GraphQL POST endpoints. The capture pipeline:
1. Filters GraphQL POST endpoints due to large request bodies
2. Cannot match class-based selectors with intent
3. Agents open browser because resolve returns wrong endpoints

## Baseline Metrics (447-session analysis)
- Browser open rate: ~60% for X.com intents
- Resolve hit rate: 45%
- Execute success rate: 20%

## Common Intents
- "load my timeline"
- "show my tweets"
- "list notifications"

## What to look for in screenshots
- Auth wall: login screen (most common)
- Empty state: "no tweets to show"
- Loading spinner that never finishes
- Rate limit page (CAPTCHA)

## Known heuristics to check
- `isApiLike()` in reverse-engineer/index.ts — does it correctly identify GraphQL POST endpoints?
- `scoreRequest()` in reverse-engineer/index.ts — does GraphQL POST get +2 bonus?
- `extractEndpoints()` — is the 2MB body cap truncating GraphQL queries?
- `rankEndpoints()` — does `rankEndpoints()` correctly score GraphQL endpoints against "timeline" intent?

## Fix targets
- A4: GraphQL POST endpoints filtered out (check `isApiLike()` bypass for GraphQL)
- C1: Class-based selectors (need better description generation)
- A1: Wrong endpoint template matching (ranker doesn't distinguish timeline vs profile endpoints)
