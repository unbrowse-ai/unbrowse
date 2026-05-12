# Ticket — `mcp-stdio.test.ts` expects `listChanged:false` but server now advertises `true`

**Severity:** P2 (test/contract drift, no user impact)
**File:** `tests/mcp-stdio.test.ts:270`
**Surface:** MCP `initialize` response `capabilities.tools.listChanged`

## Failure

```
Expected: false
Received: true
```

The test was written when the server advertised a static tool list. Per
`docs/mcp-vs-cli-ux-audit.md`, the server now flips `listChanged:true` to
support dynamic tool registration (e.g. `unbrowse_sessions` appearing once a
browse session is open).

## Decision required

Pick one. Sibling test `mcp-cheatsheet-listchanged.test.ts` ALREADY asserts
the dynamic-partition behavior — so this stdio assertion contradicts it.

- (a) Update `mcp-stdio.test.ts:270` to assert `listChanged:true` and align
      with the new contract. Smallest fix.
- (b) Re-examine the contract. If `listChanged:true` was unintentional
      (audit didn't actually decide it), revert the server to `false`.
      Larger surface.

## Why this is not "rename leftovers"

The Day-9 hand-off of the prior loop labeled the three pre-existing MCP
failures as "rename leftovers." Day-8 Audit 7 found they are three
DIFFERENT bugs. This one is contract drift between the server and a stale
test — not a renamed identifier.

## Acceptance criteria

- [ ] One assertion line changed OR server reverted.
- [ ] `bun test tests/mcp-stdio.test.ts` passes.
- [ ] No drift introduced into `mcp-cheatsheet-listchanged.test.ts` (it
      currently passes with the dynamic-partition expectation).
