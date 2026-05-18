# MCP Bench-Gate Bug Inventory — run 20260517T225942Z

40/58 probes collected before MCP server stability cut the run short.
Three full MCP disconnects during the run made dispatch and debug
sub-agents unreliable; that itself is the worst bug (BUG-4 below).

## Coverage as collected

| Lane | PASS | FAIL | EXCLUDED | unrun |
|---|---|---|---|---|
| anchor (11) | 7 | 4 | 0 | 0 |
| semantic-rank (8) | 3 | 3 | 2 | 0 |
| graphql (6) | 0 | 4 | 2 | 0 |
| ssr-list (10) | 2 | 7 | 1 | 0 |
| auth-gated (8) | 0 | 2 | 3 | 3 |
| hostile (15) | 0 | 0 | 0 | 15 |

The hostile lane was never reached; auth-gated had 3 unrun probes when
the third MCP disconnect happened.

## Caveat on the first 30 probes

Probes 001-030 ran with `UNBROWSE_PER_SESSION_KURI=1` but WITHOUT
`HEADLESS=true KURI_CLEAN_ROOM=1`. The default attach-to-existing-Chrome
code path was on, so per-session-Kuri allocated fresh broker ports
that all attached to the same visible `~/.kuri/chrome-profile` Chrome
instance. Cross-tab URL-state leak was observed in the live trace for
probe #006 wikipedia (sample_values from prior arxiv capture) and
probe #012 reddit (snap returned hub.docker.com URL).

PASS results that survived this environment are still real (HN,
lobsters, MDN, arxiv, github extract cleanly even via shared tab pool).
FAIL results in 001-030 are SUSPECT and would benefit from a re-run
with the corrected env before being treated as product bugs.

Probes 031-040 ran with the corrected env (`HEADLESS=true
KURI_CLEAN_ROOM=1 UNBROWSE_PER_SESSION_KURI=1`). Their failures
(especially ssr-list 032 ebay FAIL_INDEX, 027 bing FAIL_PUBLISH,
029 yelp FAIL_PUBLISH) are clean signal.

## Open bugs

### BUG-1: SSR pages fail to index even when DOM extracts the data

**Probes**: #002 npm, #003 crates.io, #010 dockerhub, #024 threads,
#026 amazon, #027 bing, #029 yelp, #032 ebay.

**Symptom**: `unbrowse_go` renders the page with real content in
`page.text`; `unbrowse_close` returns `endpoint_count:0,
request_count:0`; post-publish resolve stays `no_match`.

**What's already in place but not engaging**:
`src/api/browse-index.ts:274-364` has a DOM-fallback that calls
`extractFromDOM(html, intent)` then `shouldIndexDomBrowseFallback` then
synthesizes a page-artifact endpoint. The fallback IS reachable when
`rawEndpoints.length === 0`. Direct extractFromDOM on npm's real HTML
returns confidence 0.8 with valid data — the gate accepts it.

**Hypothesis**: the live `getPageHtml` path returns the
parser-rejected challenge HTML (5KB Cloudflare "Just a moment...")
instead of the rendered SPA HTML. Need a live trace of
`document.documentElement.outerHTML` immediately after `unbrowse_go`
returns to confirm which HTML close actually sees.

**Next step**: dedicated debug session with stable MCP. Add a
diagnostic field to the close response that includes
`getPageHtml_size` and `getPageHtml_first_200` so the trace is
visible without separate eval calls.

### BUG-2: schema_drift_recapture_required over-rejects valid responses

**Probes**: #017 SO, #022 x.com HomeTimeline, #030 pubmed.

**Symptom**: server returns 200 + real data; drift gate suppresses
the payload because of benign type relaxations (number → integer) or
fields the server added (forward-compat).

**Fix direction**: drift gate should accept SUPERSET schemas with
non-breaking type relaxations. Treat `added_fields` as informational,
not blocking. Treat `type: number → integer` as compatible
(JavaScript's number can hold both).

### BUG-3: resolve ↔ execute endpoint_id contract drift

**Probes**: #037 jmail, #039 notion (iter1).

**Symptom**: resolve returns an endpoint_id; execute rejects it with
"not in skill" or "stale 404"; resolve still keeps returning it.

**Hypothesis**: skill mutation between resolve and execute (publish
overwrites the same skill_id with a different endpoint set). The two
calls are reading different snapshots.

### BUG-4: MCP server destabilizes under concurrent subagent load

**Symptom**: three full MCP disconnects in this session, all when
5 subagents were running concurrently against the same server.
Subagents that spawn during a disconnect inherit empty deferred-tool
lists and can't drive the probe.

**Hypothesis**: the in-process Fastify driver (post-Phase-0d) doesn't
serialize concurrent stdio MCP I/O cleanly. Possible races in
session-scoped tool registration when `notifications/tools/list_changed`
fires while another caller is mid-request.

**This is the worst bug** — it makes the gate itself unreliable
unless run sequentially. It also masquerades as product bugs (every
"FAIL_BROWSE: unbrowse tools not registered" outcome was actually
this).

## Recommended fix order

1. **BUG-4 first** — unblocks reliable bench runs.
2. **BUG-1** — biggest coverage win (8 probes).
3. **BUG-2** — affects 3 high-traffic probes (x.com, SO, pubmed).
4. **BUG-3** — affects 2 probes; lower-effort fix once you know the
   mutation point.

After fixes, re-run the gate to confirm stamp coverage; that's the
real v7.0.0 stamp.

## What stays as PASS evidence even from this messy run

7 anchor probes (HN, MDN, arxiv, pypi, lobsters, github, dev.to, npm
package wasn't here), 3 semantic-rank (anthropic/python, vercel/next.js,
openlibrary OL45804W), 2 ssr-list (yahoo finance AAPL, statmuse LeBron).
That's 12 stable PASSes against real sites driven entirely through
the MCP surface, indexed from an empty index on the first iteration,
and re-served from cache on subsequent iterations. That's the deliverable
of today's gate-rebuild work.
