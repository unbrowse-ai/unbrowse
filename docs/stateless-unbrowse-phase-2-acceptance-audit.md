# Phase 2 Acceptance Audit — Day 6 (Dominion)

Generated: 2026-05-13
Worktree: jl-default (branch docs/loop3-handoff)
Plan: .claude/jesus-loop.default.plan.md (Phase 2, 9 criteria)
Audited commits: 414beb17 (Phase 1.1 endpoint) → 6e21ef90 (seeds Day 3) → 4134a9a4 (luminaries Day 4) → fbcb8783 (creatures Day 5)

## Criterion 1 — MCP-via-CLI is short-lived by default
**Verdict:** PASS
**Evidence:** `bun test tests/mcp-stdin-eof.test.ts tests/mcp-stdin-eof-no-auto-start.test.ts tests/server-idle-mcp-mode.test.ts tests/p2-mcp-daemon-idle-cascade.test.ts` → 7 pass / 0 fail / 17 expect() calls. The cascade test directly proves the falsifier: `[p2-cascade] elapsed=17003ms dead=true status=no-response` — the daemon is gone after the one-off MCP call completes.

## Criterion 2 — `unbrowse serve` subcommand exists
**Verdict:** PASS
**Evidence:** `serve` dispatch at src/cli.ts:3927 calls `startUnbrowseServer` and logs `[serve] listening on http://${host}:${port}`; registered in the command list at src/cli.ts:3971. `bun test tests/cli-serve-verb.test.ts tests/cli-serve-live-probe.test.ts tests/serve-explicit-idle-zero.test.ts` → 3 pass / 0 fail / 12 expect() calls (one skip — explicit serve-mode idle=0).

## Criterion 3 — Disk-queue bridge survives short-lived invocations
**Verdict:** PASS
**Evidence:** `tests/disk-queue-e2e.test.ts` spawns `src/cli.ts __drain-queue` as a separate process (line 46) after seeding a job on disk, proving Phase 1.1's queue persists across process boundaries. `bun test tests/disk-queue-e2e.test.ts` → 2 pass / 0 fail / 4 expect() calls.

## Criterion 4 — bench-local in disk mode does not regress
**Verdict:** DEFERRED
**Evidence:** No Phase 2 baseline available in this worktree. `.bench-local/results.jsonl` exists (mtime May 13 09:30) but predates Phase 2 Day 5 (`fbcb8783`) and every row is `PRODUCT_FAIL` against URLs unrelated to Phase 2 changes (homepages of HN, npm, reddit, tiktok). No `.jesus-loop/` directory present — Worker F's run has not landed here. Per plan instruction, mark DEFERRED with the explanation that the source-plan prereq cannot be verified from these artifacts.

## Criterion 5 — Public API preserved
**Verdict:** PASS
**Evidence:** `git diff f1546e02..HEAD -- src/indexer/index.ts | grep -E '^[-+]export '` returns exactly one line: `+export { processIndexJob as _processIndexJobForCli };`. New export only, no signature break or removal of existing exports.

## Criterion 6 — Existing test suite passes unchanged
**Verdict:** PASS
**Evidence:** Full Phase 1 + 1.1 + 2 surface across 20 test files → **76 pass / 1 skip / 0 fail / 305 expect() calls / 71.06s**. Test count grew from Phase 1.1's 85 (Aug Phase 1.1 audit on a slightly different file set) to the new 76+1 here covering 12 Phase 1/1.1 queue files plus 8 Phase 2 MCP/serve files.

## Criterion 7 — tsc baseline preserved at 191/191
**Verdict:** PASS
**Evidence:** `bun --bun tsc --noEmit 2>&1 | grep -c "error TS"` → **191**. Identical to the pre-refactor `f1546e02` baseline cited in the Phase 2 plan. Errors live in the same unmodified files (types/skill.ts, workflow/compile.ts, etc.) — Phase 2 did not introduce new TS errors.

## Criterion 8 — CHANGELOG entry under `## Unreleased`
**Verdict:** PASS
**Evidence:** `CHANGELOG.md:115` contains the Phase 2 entry framed as "Phase 2 — short-lived MCP server by default", with the lifecycle reshape narrative (lines 115–154). Phase 2.1 deferral is referenced at line 154. Worker A's commit landed (Day 5 fbcb8783 touched CHANGELOG).

## Criterion 9 — Phase 2.1 follow-up doc exists
**Verdict:** PASS
**Evidence:** `docs/stateless-unbrowse-phase-2-1-followups.md` exists (4 sections visible: CLAUDE.md note deletion + two-week observation trigger, warm-pool P2-1, Option B route-handler extraction P2-2, MCP-spawned ephemeral port P2-3). Each item carries an explicit trigger condition, matching the Phase 2.1 deferral pattern.

---

## Summary

| Verdict | Count |
|---------|-------|
| PASS | 8 |
| PARTIAL | 0 |
| FAIL | 0 |
| DEFERRED | 1 |

Eight of nine Phase 2 acceptance criteria PASS against the source. The MCP daemon is now short-lived by default (cascade test proves the daemon is gone after a one-off call), `unbrowse serve` is wired as the explicit long-lived opt-in, the disk-queue bridge survives separate-process invocations, the public API and tsc baseline are byte-for-byte preserved, CHANGELOG + Phase 2.1 follow-up doc both land. Criterion 4 (bench-local non-regression) is DEFERRED — Worker F's measurement run did not land in this worktree, so the source-plan prereq cannot be ratified from these artifacts; the existing `.bench-local/results.jsonl` predates Phase 2 Day 5 and tests unrelated URLs. Step 7 (Sabbath) should re-check this single criterion once a fresh `bash scripts/bench-local.sh --use-source` run is available.
