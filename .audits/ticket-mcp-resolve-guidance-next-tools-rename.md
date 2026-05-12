# Ticket — `mcp-resolve-guidance.test.ts` references retired tool name `unbrowse_login`

**Severity:** P2 (rename drift)
**File:** `tests/mcp-resolve-guidance.test.ts:26-27`
**Surface:** `addResolveMissGuidance` `next_tools` array

## Failure

```diff
"next_tools": [
- "unbrowse_login",
+ "unbrowse_auth_capture",
  "unbrowse_go",
```

The MCP tool was renamed `unbrowse_login` → `unbrowse_auth_capture`. The
fixture in the test still expects the pre-rename identifier.

## Fix

Single-line: update the expectation in `tests/mcp-resolve-guidance.test.ts:27`
from `"unbrowse_login"` to `"unbrowse_auth_capture"`.

## Why this IS the genuine rename leftover

Of the three pre-existing MCP test failures the Day-9 hand-off labeled
"rename leftovers", THIS one really is. The other two
(`mcp-stdio.test.ts` — listChanged contract drift; `mcp-cheatsheet-listchanged.test.ts`
— hardcoded tool count) are different categories of bug. Split them
correctly.

## Acceptance criteria

- [ ] One-line edit.
- [ ] `bun test tests/mcp-resolve-guidance.test.ts` passes.
- [ ] No other test file references the retired `unbrowse_login` identifier
      (grep `tests/` to confirm).
