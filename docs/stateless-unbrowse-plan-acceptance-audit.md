# Phase 1 Acceptance Audit — Day 6 (Dominion)

Generated: 2026-05-13
Worktree: jl-default
Plan: docs/stateless-unbrowse-plan.md (canonical copy not present in this worktree; criteria mirrored from `.claude/jesus-loop.default.plan.md:35-53`)
Audited commits: HEAD~3..HEAD (16e55129, 7759b4f6, f9b531b6, + Day-6 commit pending)

## Criterion 1 — API surface preserved
**Verdict:** PASS
**Evidence:** All five exports retain their signatures and exports in src/indexer/index.ts:175 (`queueBackgroundIndex`), :220 (`mergeBackgroundIndexJobs`), :513 (`isIndexingInFlight`), :518 (`drainPendingIndexJobs`), :537 (`setBackgroundIndexProcessorForTests`). `git diff HEAD~3..HEAD -- src/indexer/index.ts` shows additive changes (disk branch under `shouldRunInline()` gate) — no caller in src/browser, src/orchestrator, src/api, src/execution required edits.

## Criterion 2 — New files exist
**Verdict:** PASS
**Evidence:** `src/indexer/queue-store.ts` (167 lines) and `src/indexer/worker.ts` (96 lines) both present; introduced in commit 16e55129 and extended in f9b531b6.

## Criterion 3 — Inline mode is the default for tests
**Verdict:** PARTIAL
**Evidence:** No global preload sets `UNBROWSE_INLINE_INDEX=1`; no `bunfig.toml` exists. Inline behavior is currently achieved indirectly: `shouldRunInline()` (src/indexer/index.ts:156-159) also returns true when a custom processor is installed via `setBackgroundIndexProcessorForTests`, which existing tests do. Tests that don't install a processor would hit the disk path. Recommend a `tests/setup.ts` preload that exports `UNBROWSE_INLINE_INDEX=1` before promotion.

## Criterion 4 — Existing test suite passes unchanged
**Verdict:** DEFERRED
**Evidence:** Full `bun test tests/` was not run to completion in this audit window (Kuri-bound suites time out on macOS sandbox). Targeted indexer set (6 files, 42 tests) passes — see Criterion 5. Recommend Sabbath reviewer rerun on a Kuri-warm host.

## Criterion 5 — New tests pass
**Verdict:** PASS
**Evidence:** `bun test tests/queue-store-roundtrip.test.ts tests/queue-store-lock.test.ts tests/indexer-dispatcher.test.ts tests/indexer-merge.test.ts tests/worker-drain.test.ts tests/worker-dead-letter.test.ts` → 42 pass, 0 fail, 160 expect() calls, 840ms. Covers atomic write, flock, coalesce, drain, dead-letter, inline-parity dispatch.

## Criterion 6 — Hidden CLI verb works
**Verdict:** PASS
**Evidence:** `__drain-queue` wired at src/cli.ts:3840; spawn target uses `process.execPath + process.argv[1]` (src/cli.ts:82, src/indexer/index.ts:238). Behavior covered by tests/worker-drain.test.ts. End-to-end packaged-binary smoke not exercised in this audit.

## Criterion 7 — Opportunistic sweep wired
**Verdict:** PASS
**Evidence:** `_maybeSweepQueue()` defined at src/cli.ts:88-94; early-returns on `UNBROWSE_NO_SWEEP=1`, on inline mode, on empty queue dir, or on fresh heartbeat. Overhead bounded by two fs.stat calls before spawn. Microbenchmark of <5ms claim not measured here.

## Criterion 8 — CHANGELOG entry
**Verdict:** PASS
**Evidence:** `Unreleased > refactor` block added in this commit (CHANGELOG.md:2-18), framed as refactor with no user-visible default-config change.

## Criterion 9 — No regression on bench-local
**Verdict:** DEFERRED
**Evidence:** No `.bench-local/` artifacts present in this worktree; bench-local has not been rerun against the disk-queue branch. Inline mode is bench-local's default per CLAUDE.md, so worst-case impact is the `shouldRunInline()` branch check. Recommend Sabbath reviewer run `bash scripts/bench-local.sh --use-source --corpus-file <F> --timeout 90` and compare PASS rate against pre-Phase-1 baseline.
