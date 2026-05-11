# MCP vs CLI UX Audit

**Date:** 2026-05-11
**Scope:** `src/mcp.ts` (2029 lines) vs `src/cli.ts` (3903 lines)
**Question:** Does the MCP server deliver the same UX as the CLI, guided by tool-result hints, per the MCP 2026 cheatsheet (dynamic discovery + workflow prompts)?

## Summary

| Dimension | Status | Evidence |
|---|---|---|
| Tool surface parity with CLI | PASS | 34/34 commands mirrored as `unbrowse_<verb>` tools |
| `prompts/list` + `prompts/get` wired | PASS | `src/mcp.ts:1944-1964` |
| `resources/list` + `resources/read` wired | PASS | `src/mcp.ts:1920-1941`, `360-400` |
| Intent-based tool descriptions | PASS | `enrichToolDescription` at `598-601`, `913-914` |
| Tool-result hints injected | PASS | `_workflow_hints` at `641-681` (execute), `683-722` (capture), `747-818` (resolve-miss), `1034`/`1723`/`1740` (callers) |
| Auth-error / resolve-miss remediation | PASS | `747-818`, `970-973` |
| **`listChanged: true` on capabilities** | FAIL | hardcoded `false` at `1881`, `1884`, `1887` |
| **`notifications/tools/list_changed` emitted** | FAIL | zero occurrences in `src/mcp.ts` |
| **Structured `next_action` shape** | PASS (Phase 1, 2026-05-11) | `src/mcp.ts:680`/`709`/`831-840`: `next_action: { title, command, command_args, why }` at result root in all three `add*Hints` functions. CLI shape mirrored, dispatchable JSON `command_args` replaces CLI shell-string `command`. |
| **Multi-step workflow recipe prompts** | FAIL | prompts surface exists but no `workflow:*` recipes |

**Bottom line:** command parity is complete, primitives are wired, but the dynamism the cheatsheet sells (on-the-fly reveal + prompts-as-recipes + structured next-action) is absent.

## Gap 1 — Static capability declaration

`src/mcp.ts:1880-1890`:

```ts
capabilities: {
  tools:     { listChanged: false },
  resources: { listChanged: false },
  prompts:   { listChanged: false },
}
```

Session-scoped tools (`unbrowse_click`, `unbrowse_fill`, `unbrowse_snap`, ...) are visible at startup before any `unbrowse_go` has produced a `session_id`. The agent sees inapplicable tools and gets no signal when context changes.

**Patch sketch:**
1. Flip the three flags to `true`.
2. Split the tool registry into `STATIC_TOOLS` (resolve, execute, health, stats, skills, feedback, review, publish, annotate, index, settings, auth_capture, go) and `SESSION_TOOLS` (click, fill, type, press, select, scroll, submit, screenshot, text, markdown, cookies, eval, snap, close).
3. On successful `unbrowse_go` -> push session id into a state observer, emit `notifications/tools/list_changed`, return `SESSION_TOOLS ∪ STATIC_TOOLS` from `tools/list` while a session exists.
4. On `unbrowse_close` -> re-emit notification, return `STATIC_TOOLS` only.

## Gap 2 — Prose-only `_workflow_hints`

Today (`src/mcp.ts:650`):

```ts
hints.next_step = "MANDATORY: call unbrowse_feedback with the skill and endpoint ids and a rating..."
```

CLI shape (`src/cli.ts:1060-1066`):

```ts
next_action: {
  title: "Record feedback",
  command: `unbrowse feedback --skill ${skillId} --endpoint ${endpointId} --rating <1-5>`,
  why: "Closes the trust loop and weights this endpoint in future resolves.",
}
```

**Patch sketch:** add `next_action` at the result root alongside `_workflow_hints`. Both fields ship for one minor; deprecate prose in the next. No call sites of `_workflow_hints` break.

**Empirical evidence (Aiko trace, 2026-05-11):** On "find me food on eatigo at 54a Pagoda Street", Aiko called `unbrowse_resolve → unbrowse_go → snap → fill → press → snap → click → snap → text` and then stopped. It never called `unbrowse_review` or `unbrowse_publish`, despite `_workflow_hints.next_step` containing "Call unbrowse_review to describe the captured endpoints…". Aiko's reasoning trace ("the typical feedback/publish flow doesn't quite apply the same way") shows the prose hint is *interpretable* and therefore *ignorable*. A structured `next_action: { command: "unbrowse_review ..." }` at the result root is dispatchable and harder to talk past.


## Gap 3 — No workflow recipes in `prompts`

The cheatsheet's killer use of `prompts/get` is encoding multi-step recipes the agent can inject ("use these tools in this order"). MCP exposes the machinery but never registers a recipe.

**Patch sketch:** add `src/mcp/recipes/*.md`, each with frontmatter (`name`, `description`, `arguments`) and a body of messages. Three to start:

- `workflow:resolve-execute-feedback` — intent -> resolve -> pick -> execute -> feedback.
- `workflow:capture-review-publish` — go -> snap -> review -> publish.
- `workflow:browse-and-extract` — go -> snap -> eval -> close.

Wire `ListPromptsRequestSchema` / `GetPromptRequestSchema` handlers to read these files and template the args.

## Out of scope (this audit)

- Changes to `src/cli.ts` — CLI shape is the reference, not the target.
- Execution pipeline, Kuri client, marketplace — none of the gaps live there.
- Versioning, npm release — separate loop.

## Suggested commit sequence

One commit per layer, each independently revertible:

1. `feat(mcp): listChanged=true on tools/resources/prompts capabilities`
2. `feat(mcp): split STATIC_TOOLS vs SESSION_TOOLS, emit list_changed on session lifecycle`
3. `feat(mcp): structured next_action alongside _workflow_hints`
4. `feat(mcp): file-backed workflow recipe prompts (resolve-execute-feedback, capture-review-publish, browse-and-extract)`

Each lands behind a unit test that exercises the JSON-RPC shape only — no live Kuri needed.
