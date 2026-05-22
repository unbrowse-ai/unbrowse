# Banger best-practices — cited evidence the child contracts derive from

This file is the context-gathering record for the umbrella. Every child
contract this umbrella writes must trace back to a row here, and the row
must carry a real `source_id`. The model's memory is not a source.

## Sources pulled (2026-05-22)

- `deepwiki:browser-use/browser-use` — leading LLM browser agent. Question
  asked: what design choices make it effective for agents (output shape,
  token/step minimisation, DOM representation, error recovery).
- `deepwiki:anthropics/claude-code` — the agent harness this session runs
  in. Question asked: best practices for agent tools / MCP servers so an
  LLM uses them with minimal errors and minimal calls.
- `code:CLAUDE.md#Agent UX North Star` — unbrowse's own four invariants
  (two-call contract, fewer errors, correct retrieval, works-for-asked).
- `code:CLAUDE.md#Known Issues to Fix` — unbrowse's declared pain corpus.

## Distilled best practices -> unbrowse gap -> candidate child contract

Each row is raw evidence. The agent judges in-thread which rows become
child contracts; the umbrella never bakes the selection.

### BP-1 — Contextual, structured next-step hints
`source_id: deepwiki:anthropics/claude-code`
claude-code structures tool results so the agent knows the next move:
"contextual next-step hints relevant to the current situation",
"structured output for issues (description + reason)". unbrowse MCP today
ships prose `_workflow_hints` (see `code:docs/mcp-vs-cli-ux-audit.md`),
not a machine-readable `next_action`. Gap: the calling LLM parses English
to pick its next call. Serves North Star #1 (two-call contract) and #2
(fewer errors).

### BP-2 — Large-output handling with format-specific recipes
`source_id: deepwiki:anthropics/claude-code`
claude-code: "truncation prompts give format-specific recipes (jq for
JSON)"; "MCP tool results can override persistence via
`_meta['anthropic/maxResultSizeChars']`". unbrowse execute has a ~25KB
wire budget that ignores `path`/`extract`/`limit`, which pushes agents
off MCP onto the CLI (`memory:reference_mcp_session_scoped_tool_visibility`).
Gap: a truncated execute result is a dead end, not a recipe. Serves
North Star #4 (works for what was asked).

### BP-3 — Token-minimal output mode (flash)
`source_id: deepwiki:browser-use/browser-use`
browser-use ships a `flash_mode` output format — only `memory` + `action`,
dropping `evaluation_previous_goal`/`next_goal` — plus system-prompt
caching, to cut tokens and latency per step. unbrowse resolve always
returns the full rich shortlist (URL, score, samples, schema,
requires/yields) even when the agent only needs the id to pick. Gap: no
minimal shortlist mode. Serves North Star #1 (two-call contract, cheaper).

### BP-4 — New/changed element indicator after an action
`source_id: deepwiki:browser-use/browser-use`
browser-use marks interactive elements that appeared since the last step
with a `*[` prefix so the agent sees the delta without re-reading the
whole tree. unbrowse `snap` returns the full a11y tree (`[e0]` root) every
call; after a click the agent re-reads everything to find what changed.
Gap: no post-action delta marker. Serves North Star #2 (fewer errors,
the agent acts on the changed control, not a stale one).

## Recursion contract — why this is "contracts that write contracts"

The umbrella writes a child contract per best-practice row. Each child is
itself a full meta-harness contract: it has its own `iterate.sh`,
`verify.sh`, `ship.sh`, ledger. A child that proves too large to ship in
one wave calls `harness build` (or this umbrella's `generate-child.sh`)
to decompose into grandchildren — so a child IS also a contract that
writes contracts. The base case is a child scoped small enough that its
`verify.sh` (bun test + bench-local row) passes in one wave. The
recursion bottoms out at shippable scope, never at an empty stub.
