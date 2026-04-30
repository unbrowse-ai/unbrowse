# Verification Phase

## Context
A fix was applied. Now verify it works against known failure cases from the session analysis.

## Known failure cases
Located in `harness/cases/`:
- `x-timeline.md` — X.com: class-based selectors, GraphQL POST filtered
- `linkedin.md` — LinkedIn: 34 browser opens, 69% resolve hit but 0% execute success
- `github.md` — GitHub: stale skills ranking high

## Verification steps
1. For each failure case, run:
   ```
   unbrowse resolve "<intent>" --domain "<domain>"
   ```
2. Compare against the pre-fix baseline documented in each case file
3. Take screenshots at each step (pre, post, post-resolve)
4. Check diagnostic confidence scores — should be higher than before
5. Run `unbrowse execute <skill_id>` on the best endpoint to verify execution works

## Success criteria
- Browser-open rate drops below 25% (from 41.1%)
- LinkedIn resolve-hit → execute-success improves from 0% to 50%+
- X.com timeline resolves without browser open
- GitHub stale skill matches drop by 50%

## Output format
```
## Results

| Case          | Before (Browser Opens) | After (Browser Opens) | Delta |
|---------------|------------------------|-----------------------|-------|
| x.com         | N                      | N                     | -X%   |
| linkedin.com  | 34                     | N                     | -X%   |
| github.com    | N                      | N                     | -X%   |

## Confidence Scores
- Before: average 0.XX
- After: average 0.XX

## Screenshots
[Attach key screenshots showing before/after improvement]

## Regression
[Any fixes that broke other cases]
```
