# Wikipedia MCP route retest — 2026-10-28

After the local route fixes and node restart, `unbrowse_do` bypassed the old
zero-input fixed route for a URL with a search value. It learned the same route
ID with path `/wiki/{path[1]}` and input `search` for `planet`. A second
`unbrowse_do` for `moon` returned `how: called`, the same route ID, and
`result.ok: true`. Direct read calls with each value returned the matching
article title. No login, write, or challenge was involved.

Outcome: **semantic replay pass**. The [metadata](2026-10-28-wikipedia-retest.json)
records the checks without response bodies. The original false pass remains
documented in the [corrected smoke report](2026-10-28-public-smoke.md).
