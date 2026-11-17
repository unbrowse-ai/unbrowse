# Unbrowse MCP public route smoke check — 2026-10-28

The running local node was called through its MCP endpoint with a dedicated
agent key. Website access was limited to public search reads. No authentication
or write action was tested. The [metadata results](../mcp-smoke-results.json)
contain route IDs and outcomes, without tokens or response bodies.

| Site | First query | First result | Second query | Replay result |
| --- | --- | --- | --- | --- |
| Wikipedia | `planet` | `learned`, `result.ok: true`; saved fixed `/wiki/Planet` route with no inputs | `moon` | `called`, same route ID and HTTP success, **semantic failure**: route cannot bind `moon` |
| GOV.UK | `passport` | `learned`, `result.ok: true`; saved `keywords` input | `driving licence` | `called`, same route ID, `result.ok: true`; content-level change was not recorded |

**Revised summary:** 2 sites, 4 MCP calls, 2 learned routes, 2 transport-successful replays, **0 confirmed semantic replay passes** from this run. The Wikipedia replay failed the search assertion. GOV.UK's route has an input, but the original metadata did not retain an answer assertion.
This is separate from the 400-site public HTTP pass; the other 398 sites have
not been tested for MCP route learning and replay.

A later [Wikipedia retest](2026-10-28-wikipedia-retest.md) with the patched
local node learned a bound `search` input and confirmed distinct Planet and
Moon article answers. It is a separate run and does not change the original
smoke outcome.
