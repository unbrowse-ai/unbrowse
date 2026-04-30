# Repair Phase

## Context
The diagnosis phase identified a root cause. Now you need to fix it using unbrowse's primitives and code edits.

## Available primitives
Run these via `bun run src/cli.ts` (or `unbrowse` if installed globally):

- `unbrowse go <url>` — open browser tab
- `unbrowse snap --filter interactive` — a11y snapshot of interactive elements
- `unbrowse screenshot --session <id>` — capture screenshot from browser session
- `unbrowse resolve <intent> --domain <d>` — find APIs for an intent
- `unbrowse execute <skill_id> --endpoint <id>` — run a specific endpoint
- `unbrowse feedback <endpoint_id> --score <1-5>` — rate an endpoint's quality
- `unbrowse review <skill_id>` — push reviewed descriptions back to skill
- `unbrowse publish` — publish/reindex cached skills to marketplace
- `unbrowse cleanup-stale` — evict stale cached endpoints

## What to do
1. Apply the code fix identified in diagnosis
2. Run `bun run typecheck` to verify no type errors
3. Run `unbrowse resolve <intent>` to verify the fix works
4. Take screenshots to confirm visual context is correct
5. If the fix breaks something, roll back and try a different approach

## Code edit principles
- Prefer minimal changes — one heuristic fix, not a rewrite
- Add diagnostic context (not just fixes) so future repairs are faster
- When in doubt, instrument more than change — add logging, add scores
- Always run `bun run typecheck` after edits

## Output format
```
## Fix Applied
[What changed and why]

## Verification
- Typecheck: [pass/fail]
- Resolve test: [result]
- Screenshot: [what changed visually]

## Remaining Issues
[What still needs fixing]
```
