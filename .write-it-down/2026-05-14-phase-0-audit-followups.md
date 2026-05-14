# Phase 0 audit follow-ups (Day 8 Judgement)

13 cold auditors reviewed Phase 0 of the MCP primitive refactor. Most findings cleared or were out-of-scope. Two real residuals worth noting for the next loop session.

## R1 - detached-async failure class (A5 + A7)

Phase 0c's `process.on('uncaughtException')` + `process.on('unhandledRejection')` guards emit a JSON-RPC `-32603` envelope when `currentRequestId !== null`. They read the module-level slot that `handleRequest` stamps before dispatching and clears in a finally.

**Limitation:** if a tool handler kicks off a fire-and-forget Promise / setTimeout / setImmediate whose rejection fires AFTER `handleRequest`'s finally has cleared `currentRequestId`, the guard reads null and skips the emit. The pipe stays open (no `-32000 Connection closed` regression), but the agent gets no envelope for that specific request id - effectively a zombie-id silent drop.

This is acceptable for Phase 0c's stated contract ("process resilience: pipe survives handler throws") but does not fully solve agent-UX clarity on second-order async failures. The original carousell-shoes failure (synchronous handler throw) IS fully fixed; the detached-async class is fixed only structurally (pipe survives), not semantically (agent sees an envelope).

**Mitigations to consider in a future loop:**

- Add `AsyncLocalStorage` to carry request id through await chains. Cost: per-await wrapper overhead forever. Per the Step 2 firmament rationale, the sequential stdio loop did not need this; but the detached-async class does.
- Tighten handler discipline: audit handlers for fire-and-forget patterns. Any handler that schedules a detached promise must catch its own rejection.
- Emit a generic envelope with `id: null` and a `description: "untracked async failure"` field when the slot is empty. Carries the risk of substrate authoring prose another agent will read.

## R2 - jl/default branch carries non-Phase-0 commits (A11)

After my Day 7 Sabbath snapshot landed at `9f9b4c06`, three additional commits arrived on `jl/default` between 09:30 and 09:45:

- `5ab2c74b fix(publish): per-execute passive publish honors capture-pipeline settings`
- `6940a621 feat(release): strict opaque-tarball gate at precommit, publish, and preview`
- `d2661adb chore(release): restore executable bit on release-and-verify.sh`

These were NOT made by the Phase 0 loop. Likely a parallel agent session or manual commits. They are valid work but live outside the Phase 0 plan's OUT-OF-SCOPE list (the publish path edit touches the marketplace path, which the plan forbid).

When `/reap` opens the PR off `jl/default`, those three commits will ship alongside Phase 0. They will get their own review; the Phase 0 commits remain independently revertible.

If the next loop session needs a clean Phase-0-only branch: cherry-pick `7506ac39 b04f3e6a 49c9770e 86967db8 88d35d32` (plus this audit-fix commit) onto a fresh branch off origin/main.

## R3 - minor cosmetic findings (accepted, no action)

- **A3:** `:6969` daemon banner is hardcoded but tests use `getFreePort()` per-suite. No port collision in practice. Cosmetic improvement: banner should print the resolved port.
- **A4:** the catch refactor from `jsonRpcResult(id, errorResult(message))` to `jsonRpcError(id, -32603, ...)` is uncovered by existing tests (no test asserted the old shape on a handler throw). The 4 new resilience tests cover the new shape. No regression risk; consider adding a contract pin test.
- **A10:** the three Phase 0 commit messages have the template's spirit (conventional prefix, phase number, verification command, refs) but lack literal file:line bullets and Phase 0b drops the "still-failing gates" section. Soft fail. CLAUDE.md says NEVER amend; accept as-is.

## R4 - A1 substrate-prescription concern (FIXED inline this commit)

The original `unbrowse_fetch` description and handler text carried a 3-call recovery sequence ("Use unbrowse_resolve { intent, url, raw: true } or unbrowse_go { url } then unbrowse_markdown") - a format template the substrate would have a removed-tool surface speak to other agents. Per CLAUDE.md "substrate enables; does not prescribe" this drifts toward prescription.

Tightened in commit (forthcoming) to a single-pointer rename truth: "Removed. Call unbrowse_resolve instead." Substrate states the rename, does not enumerate alternatives. All 12 lights still pass.
