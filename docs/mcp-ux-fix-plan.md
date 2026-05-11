# Plan: Fix MCP UX to match CLI (with on-the-fly hints)

**Companion to:** `docs/mcp-vs-cli-ux-audit.md`
**Falsifier:** `scripts/verify-mcp-audit.sh` (currently green; will flip to red as each phase lands)
**Trigger:** Aiko eatigo trace, 2026-05-11 — agent did `resolve → go → snap → fill → press → click → text` and stopped. Reasoned past the prose hint `"Call unbrowse_review to describe the captured endpoints…"` with the line: *"the typical feedback/publish flow doesn't quite apply the same way."*
**North star:** Aiko's next equivalent run closes the loop without further prompting — `unbrowse_review` and `unbrowse_publish` are called before the final answer.

## Diagnosis (one sentence)

The MCP returns prose hints in a nested `_workflow_hints` field that an LLM can *interpret away*; the CLI returns a structured `next_action: { title, command, why }` at the result root that callers dispatch on. Aiko didn't ignore the hint — it read the hint, judged it inapplicable, and skipped it.

## Out of scope

- Changes to `src/cli.ts` — CLI shape is the reference target, not the work.
- Execution pipeline, Kuri client, marketplace publish backend.
- npm release / `CHANGELOG.md` / `version.json` — separate loop.
- Adding new tools. Every fix uses tools that already exist.

## Acceptance criteria

A reviewer (Lewis or one teammate) answers yes to every line:

1. `bash scripts/verify-mcp-audit.sh` exits 1 with FAIL rows for Gap 2b (next_action absent) flipping to PASS-becomes-FAIL — i.e. the audit goes stale because the gap closed.
2. Every MCP tool result that contains `_workflow_hints` ALSO contains a root-level `next_action: { title, command, why }`.
3. The `next_action.command` is a literal MCP tool name + JSON args block the agent can copy-paste into its next call. No prose verbs ("Consider calling…"). No placeholder IDs ("<skill-id>"); use real values from the result.
4. After `unbrowse_go` succeeds, the server emits `{ "jsonrpc":"2.0", "method":"notifications/tools/list_changed" }`. After `unbrowse_close`, it emits the notification again.
5. `tools/list` returns 14 tools (static set) before any session is open; returns 28 tools (static + session) while a session exists.
6. `prompts/list` returns at least one new entry whose `name` starts with `workflow:`. `prompts/get` for `workflow:browse-and-publish` returns a message array that names `unbrowse_review` and `unbrowse_publish` in order.
7. A unit test (`tests/mcp-next-action-shape.test.ts`) asserts the shape on resolve / execute / go / close result paths. Test runs with no live Kuri.
8. A repro test (`tests/mcp-aiko-eatigo-repro.test.ts`) simulates the Aiko trace: opens session, sends snap/fill/press/click/text, calls close, and asserts the close result carries `next_action.command` starting with `unbrowse_review`.
9. No new dependencies. Every change is a delete/replace in existing files (`src/mcp.ts`, new file `src/mcp/recipes/*.md`).
10. `bun --bun tsc --noEmit` adds zero new errors over baseline.

## Phases (each phase is one independently-revertible commit)

### Phase 1 — Structured `next_action` alongside prose (Gap 2)

**Files:** `src/mcp.ts`
**Functions touched:** `addExecuteNextStepHints` (641), `addCaptureNextStepHints` (683), `addResolveMissGuidance` (747)
**Shape target:**

```ts
// At result root, alongside (not replacing) _workflow_hints:
next_action: {
  title: "Review the captured endpoints",
  command: `unbrowse_review`,
  command_args: { session_id, intent: args.intent },
  why: "Required before publish so the marketplace gets a real schema.",
}
```

**Acceptance:** verifier `Gap 2b` flips from PASS (audit-claim-true) to FAIL (claim now broken). Existing `_workflow_hints` field stays for back-compat — both ship together for at least one minor version.

**Test:** `tests/mcp-next-action-shape.test.ts` — calls each `add*Hints` function with a sample input, asserts shape.

**Estimate:** ~40 lines changed, 1 hour.

### Phase 2 — `listChanged: true` + session-aware tool list (Gap 1)

**Files:** `src/mcp.ts`, new `src/mcp/session-visibility.ts`

**Changes:**

1. `src/mcp.ts:1880-1888` — flip three `listChanged: false` → `true`.
2. Split the 34-tool registry into:
   - `STATIC_TOOLS` (14): resolve, execute, health, stats, skills, skill, feedback, review, publish, annotate, index, settings, auth_capture, go.
   - `SESSION_TOOLS` (14): click, fill, type, press, select, scroll, submit, screenshot, text, markdown, cookies, eval, snap, close.
3. New module `src/mcp/session-visibility.ts` — exports `hasOpenSession()`, `markSessionOpen(id)`, `markSessionClosed(id)`, `onChange(cb)`.
4. `tools/list` handler reads `hasOpenSession()`; returns either `STATIC_TOOLS` or `STATIC_TOOLS ∪ SESSION_TOOLS`.
5. On `unbrowse_go` success: `markSessionOpen(id)` → emit `{ "jsonrpc":"2.0", "method":"notifications/tools/list_changed" }` to stdout.
6. On `unbrowse_close` success: `markSessionClosed(id)` → emit the same notification.

**Acceptance:** verifier `Gap 1a/b/c/d` flip to FAIL.

**Test:** `tests/mcp-list-changed.test.ts` — drives JSON-RPC over a memory pipe, asserts `tools/list` size before/after `unbrowse_go`, asserts the notification fires.

**Estimate:** ~120 lines changed/added, 2-3 hours.

### Phase 3 — Workflow recipe prompts (Gap 3)

**Files:** new `src/mcp/recipes/*.md`, `src/mcp.ts` prompts handlers

**New files:**

- `src/mcp/recipes/workflow-resolve-execute-feedback.md`
- `src/mcp/recipes/workflow-browse-and-publish.md`
- `src/mcp/recipes/workflow-extract-and-go.md`

Each has YAML frontmatter:

```yaml
---
name: workflow:browse-and-publish
description: Open a site, capture data, then close the loop (review + publish).
arguments:
  - name: intent
    description: The user's natural-language ask.
    required: true
  - name: url
    description: Target URL.
    required: true
---
```

Body is a message array (markdown headings → role transitions) describing the canonical sequence: `unbrowse_go(url)` → interact → `unbrowse_close` → **MANDATORY** `unbrowse_review` → `unbrowse_publish`.

**Changes to `src/mcp.ts`:**

- `prompts/list` handler enumerates `src/mcp/recipes/*.md`.
- `prompts/get` handler reads the file, parses frontmatter, templates `{intent}` / `{url}`, returns the messages.

**Acceptance:** verifier `Gap 3` flips to FAIL. `prompts/list` returns 3+ entries with `workflow:*` names.

**Test:** `tests/mcp-recipes.test.ts` — lists, gets each recipe with sample args, asserts the message text mentions the required tool sequence.

**Estimate:** ~80 lines new, 4 markdown files, 2 hours.

### Phase 4 — Aiko eatigo regression test

**File:** new `tests/mcp-aiko-eatigo-repro.test.ts`

Drives a recorded JSON-RPC trace mimicking Aiko's actual sequence (no live Kuri — uses fixture responses). Asserts the **close** result carries `next_action.command === "unbrowse_review"`. This test ships failing without Phases 1+3 and passing once they land.

**Estimate:** ~60 lines, 1 hour.

## Commit sequence

```
feat(mcp): structured next_action alongside _workflow_hints
feat(mcp): listChanged=true + session-aware tool list with list_changed notifications
feat(mcp): file-backed workflow recipe prompts (resolve-execute-feedback, browse-and-publish, extract-and-go)
test(mcp): aiko eatigo regression — close result must carry next_action: unbrowse_review
```

Four commits, each revertible alone. Phase 1 is the highest-leverage smallest slice — if only one ships, ship that.

## Risks

- **Both fields (`_workflow_hints` + `next_action`) increase result payload size.** Mitigation: prose `next_step` becomes a one-liner that just restates `next_action.title`. Net size grows by ~80 bytes per result.
- **Existing MCP clients may key off `_workflow_hints` shape and break if it changes.** Mitigation: keep the field exactly as today; only ADD `next_action`.
- **Notification emission requires the MCP server's transport to support stdout writes mid-response.** Mitigation: check the SDK version pinned in `package.json`; the `@modelcontextprotocol/sdk` server.notification API exists since 1.0.
- **Recipes-as-files introduces a build/packaging question — are markdown files bundled into the npm dist?** Mitigation: include `src/mcp/recipes/*.md` in `files` array of `packages/skill/package.json`; or inline as a JS const if packaging proves brittle.
- **Aiko regression test could be flaky if it depends on a live MCP server.** Mitigation: use the in-process MCP server import (`import { server } from "../src/mcp"`) and drive JSON-RPC through a memory transport, not a child process.

## Verification loop

After each phase:

1. `bash scripts/verify-mcp-audit.sh` — expect the relevant Gap row to flip from PASS to FAIL.
2. Update `docs/mcp-vs-cli-ux-audit.md` summary table — flip that row's Status from `FAIL` to `PASS` (audit shape converged with cheatsheet).
3. `bun test tests/mcp-*.test.ts` — every new test green.
4. `bun --bun tsc --noEmit` — no new errors.
5. Drive Aiko (or a stub harness simulating it) against eatigo — confirm review + publish fire without prompt.

When `bash scripts/verify-mcp-audit.sh` exits with **every Gap row flipped** (audit is fully stale because all gaps closed), the work is done. Update the audit to reflect the new state, commit, ship.
