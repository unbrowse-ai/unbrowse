# Ticket — `mcp-cheatsheet-listchanged.test.ts` asserts stale tool count (33 vs 36)

**Severity:** P2 (test drift)
**File:** `tests/mcp-cheatsheet-listchanged.test.ts:79`
**Surface:** MCP `tools/list` response

## Failure

```
expect(tools.length).toBe(33);
Expected: 33
Received: 36
```

Three tools were added since this assertion was last touched. The test
should not hardcode the absolute count — it should assert presence of the
tools whose dynamic-partition behavior the test is actually exercising.

## Fix

- Replace `expect(tools.length).toBe(33)` with a SHAPE-based assertion:
  e.g. `expect(tools.map(t => t.name)).toEqual(expect.arrayContaining([
    "unbrowse_resolve", "unbrowse_execute", "unbrowse_sessions"
  ]))` and a separate check that no duplicate names are present.
- This stops the assertion from rotting every time a tool is added or
  renamed.

## Why this is not "rename leftovers"

A static tool-count expectation is a brittle test, not a stale name. It
breaks any time a new tool ships — orthogonal to renames.

## Acceptance criteria

- [ ] No hardcoded integer in the tool-count assertion.
- [ ] Test passes today AND survives the next tool addition without edit.
- [ ] `bun test tests/mcp-cheatsheet-listchanged.test.ts` passes.
