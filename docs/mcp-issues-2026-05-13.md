# MCP issues observed in-thread, 2026-05-13

Captured while running a real agent task (resolve → live capture → execute on
carousell.sg and eatigo.com). Two distinct issues, ordered by how badly they
break the canonical agent flow.

---

## Status update (added 2026-05-13 during Jesus-loop Day 3 / Land)

**Issue 1 is mostly already fixed in source.** Commit `421c5387`
("fix(mcp+orchestrator): MCP audit follow-through", 2026-05-12) added
`dietIfOversize()` at `src/mcp.ts:787–824` with a 3-pass algorithm that
preserves Array shape for projected list responses via
`capOversizeArrays`'s tail sentinel `{truncated:N, unit:"items"}`. The
agent now gets an Array of partial rows, not a `body_excerpt` blob, for
the common over-budget projection case.

The live failure Lewis observed on 2026-05-13 was a **stale
`dist/mcp.js` daemon** (confirmed in `tests/mcp-projection-stdio.test.ts`
lines 13–16). Source-side path is correct; the daemon was running
pre-`421c5387` code.

Commit `3c153b1e` (2026-05-13) pinned three contract tests against
`maybePostProcessResult` + `dietIfOversize`. Currently lives on
`docs/loop3-handoff`, not yet merged to `main`.

**What still remains** (the loop is sized to these gaps):

- **AC3 — `next_step` field in body_excerpt wrapper.** Pathological case:
  when even pass-2 array-cap (50 items + sentinel) overshoots budget,
  `dietIfOversize` falls back to `{truncated:true, reason, body_excerpt}`
  with no actionable hint. The agent loses the array. Fix is ~3 LoC at
  `src/mcp.ts:820–826`: add `suggested_limit` and `next_step` fields.
- **AC4 — eatigo-shape regression test.** No test reproduces the exact
  doc reproducer (297 rows × 4-field extract). To be added Day 4
  (Luminaries) alongside the AC3 fix.
- **AC6 — bench-local probe.** No probe exercises `path`/`extract`/`limit`
  on a list endpoint > 25KB. Add to `harness/probes/` Day 5 (Creatures).
- **AC7 — CHANGELOG entry.** Day 6 (Dominion).

**What is OUT of scope** (per the original NON-GOALS, reaffirmed):
Issue 2 cosmetic messaging, MCP streaming, env knobs, mirror sync at
`.agents/skills/unbrowse/src/mcp.ts`, backend POST-body forwarding of
projection params (client-side projection already works).

---

## Issue 1 — `unbrowse_execute` 25 KB wire-budget clamp ignores projection params

**Severity:** High. Breaks the "MCP is the canonical path" contract for any
list endpoint larger than a handful of rows. Forces agents off MCP onto the
CLI, which violates the agent-UX north star (two-tool-call contract).

### Reproducer

```jsonc
// Tool: mcp__unbrowse__unbrowse_execute
{
  "skill":     "IdW25ToUDmN6xuz0fQsfV",      // eatigo skill captured this session
  "endpoint":  "VVc4dxazx-HQEW6dtyboJ",      // GET /v2/eatigo/restaurant
  "params":    { "filter_regionid": 27, "size": 297, "start": 0, "sortby": "popular" },
  "path":      "data.list[]",
  "extract":   "name,area,lat,lng",
  "limit":     297
}
```

### Observed response

```jsonc
{
  "truncated": true,
  "reason":    "payload_exceeded_wire_budget_after_diet",
  "budget_chars":   25000,
  "original_chars": 565328,           // <-- 565 KB after the "diet"
  "body_excerpt":   "{\"trace\":{...first ~600 chars...}"
}
```

The agent gets ~600 characters of an excerpt and no way to recover the rest.
A repeat call with `path`/`extract`/`limit` left out still produced
`original_chars: 588055` — i.e. the projection params reduced size by ~4 %
(from 588 KB → 565 KB), so they ran but did not bring the payload under 25 KB.
The clamp is then total, not paginated.

### Why this matters

- The same data fetched from the CLI (`unbrowse execute ... --raw`) returns
  the full 565 KB JSON cleanly; the agent can `python3 | head` it and
  filter client-side. CLI works, MCP does not — and the project explicitly
  prefers MCP as the agent default.
- A 297-row list of restaurants is not an unusual size. Any
  search/list/feed/timeline endpoint will hit this.
- Per `CLAUDE.md` "two tool calls is the contract — never one." When MCP
  truncates, the agent is forced into either (a) calling the CLI through
  Bash, (b) paginating with tiny `size` values, or (c) failing the task.
  All three break the contract.

### Suspected root cause (unverified, needs source read)

Two candidate sites in `src/mcp.ts`:

1. The response-shaping path runs `path`/`extract`/`limit` projection,
   then applies a fixed `WIRE_BUDGET_CHARS = 25000` clamp on the final
   serialized JSON. The clamp doesn't know whether the projection
   already happened, so even a fully-projected response gets cut.
2. The "diet" step (`payload_exceeded_wire_budget_after_diet` is the
   literal reason string) is doing field-pruning heuristics, not
   honoring caller-supplied `path` / `extract` / `limit`. Caller
   projection should be authoritative and replace the diet, not run
   alongside it.

### Suggested fixes (in preference order)

1. **Apply caller `path`/`extract`/`limit` first and trust the result.** If
   the projected response is still > 25 KB, that's the agent's call to
   ask for less — return the projected result, not an excerpt.
2. **Page large arrays at the MCP boundary.** Return the first N items
   that fit in the budget plus a continuation cursor. Better than
   silent truncation.
3. **Surface a clear next-step in the truncation payload.** Today the
   `body_excerpt` is uninvited dead weight. Replace with
   `{"truncated": true, "next_step": "call again with limit=N or
    path='data.list[0:N]'"}` so the agent knows how to recover.
4. **Stream over MCP** (lowest priority — protocol-level work).

### Cross-references

- `docs/mcp-vs-cli-ux-audit.md` — pre-existing audit of MCP gaps vs CLI.
- `CLAUDE.md` → "Use schema/path/extract/limit style filtering inside
  Unbrowse instead of external jq/python post-processing." This issue
  is what makes that line not work in practice.

---

## Issue 2 — "MCP server disconnected" messaging is misleading

**Severity:** Low (cosmetic / UX), but it costs the agent turns to
re-load schemas via `ToolSearch` and burns context with re-announcement.

### Reproducer

1. `mcp__unbrowse__unbrowse_go { url: "..." }` opens a session.
2. Inspect via snap / text / eval / fill (etc.) — these work.
3. `mcp__unbrowse__unbrowse_close { session_id: "..." }` closes it.
4. Next turn the harness emits:

   ```
   <system-reminder>
   The following deferred tools are no longer available
   (their MCP server disconnected). Do not search for them
   — ToolSearch will return no match:
     mcp__unbrowse__unbrowse_click
     mcp__unbrowse__unbrowse_close
     mcp__unbrowse__unbrowse_cookies
     mcp__unbrowse__unbrowse_eval
     mcp__unbrowse__unbrowse_fill
     mcp__unbrowse__unbrowse_markdown
     mcp__unbrowse__unbrowse_press
     mcp__unbrowse__unbrowse_screenshot
     mcp__unbrowse__unbrowse_scroll
     mcp__unbrowse__unbrowse_select
     mcp__unbrowse__unbrowse_snap
     mcp__unbrowse__unbrowse_submit
     mcp__unbrowse__unbrowse_sync
     mcp__unbrowse__unbrowse_text
     mcp__unbrowse__unbrowse_type
   </system-reminder>
   ```

5. The 6 stateless tools (`go`, `resolve`, `execute`, `feedback`,
   `review`, `publish`) stay loaded.

### Why this is not actually a disconnect

The 15 vanishing tools are **exactly** the ones that require an open
browser tab to operate on. The 6 survivors are tab-agnostic. The most
plausible reading is that `src/mcp.ts` emits
`notifications/tools/list_changed` after the last session closes and
the listed tool set narrows. The Claude Code harness renders that
shrinkage as "MCP server disconnected" — which sounds like a fault
but is expected behavior.

If the daemon at `localhost:6969` had actually died, **all 21**
`unbrowse_*` tools would have dropped — not 15. The selectivity is
the tell. See `reference_mcp_fastify_auto_spawn.md` +
`reference_mcp_session_scoped_tool_visibility.md` in memory for the
architectural backdrop.

### What it costs the agent

- Every `unbrowse_close` triggers a system-reminder dumping the 15
  tool names. Re-emitted again on the next `unbrowse_go` ("reconnected").
  Pure context bloat.
- The agent has to re-`ToolSearch select:mcp__unbrowse__unbrowse_snap,...`
  to reload schemas before driving a fresh session. This burns a turn.
- New agents read the literal "MCP server disconnected" text and
  diagnose a phantom fault.

### Suggested fixes

1. **Rename the harness message.** "Tools deregistered (no browse
   session active)" or "Session-scoped tools unavailable" is honest.
   This is a Claude Code harness change, not an unbrowse change.
2. **Don't re-announce.** Once the agent has been told the 15 tools
   are out, repeating the list on every subsequent turn is noise.
3. **Optionally: keep session-scoped tool schemas advertised always**,
   and have them return a clean `no_active_session` error when called
   without a session. Less churn, slightly less safety.

### Open question

Whether the harness message originates from (a) a literal stdio
connection event, or (b) the harness diffing `tools/list` responses
and labelling shrinkage as "disconnect." Reading
`src/mcp.ts` around the tool registration / `list_changed` emission
would resolve this — until then this is inference from observed
pattern, not source-verified.

---

## What I'd ship first

Issue 1 — the wire-budget clamp — is the load-bearing one. Fixing it
turns a half-working MCP into a working MCP. Issue 2 is a
re-naming + a noise-suppression and can wait. The order matches the
agent-UX north star: fewer errors > shorter prose.
