# Debug #002 — npmjs.com/package/openai — v2 (sub-agent run)

**Date:** 2026-05-18
**Probe:** `intent=get package info`, `contextUrl=https://www.npmjs.com/package/openai`
**Server flags at dispatch:** `HEADLESS=true KURI_CLEAN_ROOM=1 UNBROWSE_PER_SESSION_KURI=1`
**Failure code under investigation:** `FAIL_INDEX_NO_ENDPOINTS`

## STATUS: probe could not be driven — `mcp__unbrowse__*` tools not callable in this agent

The unbrowse MCP server is registered with this Claude session — its **resources**
surface fine via `ListMcpResourcesTool` (33+ workflow contracts, DAGs, publish
artifacts visible from earlier runs, all with `"server":"unbrowse"`). But its
**tools** (`unbrowse_resolve`, `unbrowse_go`, `unbrowse_eval`, `unbrowse_close`,
`unbrowse_snap`, etc.) are NOT in the deferred-tool inventory.

Searches attempted (all returned zero unbrowse tools):

- `ToolSearch query="+unbrowse"` → no matches
- `ToolSearch query="unbrowse_resolve"` → no matches
- `ToolSearch query="unbrowse_go unbrowse_close unbrowse_eval"` → no matches
- `ToolSearch query="mcp__unbrowse"` → no matches
- `ToolSearch query="resolve intent contextUrl"` → returned Linear/muonry only
- `ToolSearch query="browse session snap eval close"` → returned EnterWorktree/Cron/Monitor only
- `ToolSearch query="mcp unbrowse browse"` → returned Linear/Notion/WebFetch only

The instructions forbid CLI and curl, and I have no way to drive `unbrowse_resolve`/
`unbrowse_go`/`unbrowse_eval`/`unbrowse_close` from this agent. Without those
calls there is no live HTML, no `session_id`, no close payload — no v2 evidence.

## Live HTML on tab (size + first 200 chars)

**NOT COLLECTED.** `mcp__unbrowse__unbrowse_eval` is not callable in this agent
(see status section). The script `document.documentElement.outerHTML.length` was
never executed and the live `<head>` is not observable here.

## Close response — full JSON

**NOT COLLECTED.** `mcp__unbrowse__unbrowse_close` is not callable in this agent.
No `indexed`, `mode`, `endpoint_count`, `request_count`, `skill_id`, or
`pipeline` fields to report.

## Diagnosis

The literal sub-agent task is not executable in this agent's tool surface, so
the live-tab diagnosis the parent asked for cannot be produced here. What can
be said from the surrounding evidence:

1. **Tool-side asymmetry, not a server crash.** Unbrowse resources are
   surfaced in this session (33+ entries listed by `ListMcpResourcesTool`,
   each with `"server":"unbrowse"` and recent skill IDs like
   `rKezwUgUVsHgayWj1B4c9`). Resources surfacing without tools is consistent
   with two known patterns recorded in project memory:

   - **Session-scoped tool de-registration after close**
     (`reference_mcp_session_scoped_tool_visibility.md`): 15 of unbrowse's
     browser-interaction tools (`unbrowse_go`, `unbrowse_eval`, `unbrowse_snap`,
     `unbrowse_close`, etc.) de-register on `unbrowse_close`. Only the 6
     stateless tools stay. If the parent's MCP gate run closed a session
     before spawning this sub-agent, the sub-agent inherits a tool surface
     missing exactly the tools needed to drive #002.

   - **MCP wedged by stale global daemon**
     (`reference_mcp_wedged_by_stale_global_daemon.md`): a stale
     `:6969` global daemon crash-looping while the Phase-0d source MCP is
     up wedges browse transport permanently; only a user-driven `/mcp`
     reconnect fixes it. In that state `unbrowse_go` reproducibly fails
     5/5 in a clean env — and depending on which side fails the handshake,
     the tool list itself can come back empty.

2. **Implication for the #002 `FAIL_INDEX_NO_ENDPOINTS` hypothesis.** The
   parent's working theory is "page clearly renders but close does not index
   it." That hypothesis needs the live `outerHTML.length` + first 200 chars
   to be falsified against the Cloudflare-challenge alternative. Without
   `unbrowse_eval` callable from this agent, the falsifier cannot be run
   in-thread. The right next step is at the parent's level, not this
   sub-agent's:

   - Parent reconnects the unbrowse MCP (`/mcp` reconnect) so the
     session-scoped tools re-register; OR
   - Parent confirms no stale `:6969` daemon is crash-looping
     (`pkill -9 -f 'unbrowse|kuri'` per CLAUDE.md, then restart MCP); OR
   - Parent drives the probe from a fresh agent where `mcp__unbrowse__*`
     tools are present in the deferred-tool list at spawn time.

3. **Do not stamp / do not bypass.** Project memory is explicit:
   "gate cannot run, do NOT stamp/bypass." This sub-agent's inability
   to drive the probe is a tool-surface fault, not evidence about the
   #002 page itself. No `FAIL_INDEX_NO_ENDPOINTS` verdict for npm
   should be derived from this run.

## Evidence the sub-agent CAN provide

- Resources visible via `ListMcpResourcesTool` confirm the unbrowse MCP
  server is connected to this session (`"server":"unbrowse"` appears
  on every workflow artifact returned).
- Most recent visible publish artifact in this session:
  `workflow_publish://rKezwUgUVsHgayWj1B4c9` — app.slack.com, not npm.
  No npmjs.com workflow publish artifact is currently surfaced as a
  resource, which is consistent with prior #002 runs failing at index
  time (no skill published to surface as a resource).
- No `mcp__unbrowse__*` function definition appears in this agent's
  tool inventory at any point in the run. The capability gap is
  structural, not transient mid-run.
