# Diagnosis Phase

## Context
You are analyzing unbrowse's agent experience failures. A 447-session analysis shows a 41.1% browser-open rate — agents keep giving up because they can't find the right APIs.

## What you have
- Raw capture data: intercepted network requests, response bodies, cookies
- Visual context: screenshots at key capture points (pre-capture, post-capture, post-resolve)
- Execution traces: what endpoints were found, scored, and rejected
- Session analysis: which hosts fail most often (x.com, linkedin.com, github.com)

## Your job
1. Look at the screenshots — what does the page actually show? Is there an auth wall? JavaScript rendering issue? Rate limit?
2. Look at the captured requests — which ones are actual API calls? Which ones were filtered out and why?
3. Look at the endpoint scores — are the right endpoints being ranked? Are wrong ones getting boosted?
4. Identify the ROOT CAUSE, not the symptom:
   - Wrong endpoint template match (A1)?
   - Stale skill cached (A2/E1)?
   - GraphQL POST filtered (A4)?
   - Empty response bodies (H1)?
   - Domain cache serving wrong skill (C1)?

## Output format
```
## Root Cause
[One sentence identifying the root cause]

## Evidence
- Screenshot analysis: [what visual evidence shows]
- Request analysis: [which requests were captured/missed]
- Ranking analysis: [how endpoints were scored]
- Code location: [file:line where the heuristic is wrong]

## Fix Plan
[What to change and why]
```
