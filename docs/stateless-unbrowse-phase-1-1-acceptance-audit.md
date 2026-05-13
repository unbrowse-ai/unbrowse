# Phase 1.1 Acceptance Audit — Day 6 (Dominion)

Generated: 2026-05-13
Worktree: jl-default (branch docs/loop3-handoff)
Plan: .claude/jesus-loop.default.plan.md (Phase 1.1, 9 criteria)
Audited commits: ea664169 (Phase 1 endpoint) → 7282cfc6 (seeds Day 3) → 726c7815 (luminaries Day 4) → 1bb31e8a (creatures Day 5)

## Criterion 1 — Global worker.lock: at most one drain worker per machine
**Verdict:** PASS
**Evidence:** `tryAcquireWorkerSlot` defined at src/indexer/queue-store.ts:236 and called from all three spawn/entry sites: src/cli.ts:95 (`_maybeSweepQueue`), src/cli.ts:3877 (`__drain-queue` entrypoint), src/indexer/index.ts:235 (disk-branch dispatcher). `bun test tests/worker-slot-spawn-bounded.test.ts` → 3 pass / 0 fail / 10 expect() calls.

## Criterion 2 — Silent loss eliminated: listJobsWithRejects + quarantine
**Verdict:** PASS
**Evidence:** `listJobsWithRejects` exported at src/indexer/queue-store.ts:273 and consumed by the drain loop at src/indexer/worker.ts:21 (destructures `{ accepted, rejected }`). `bun test tests/queue-list-jobs-with-rejects.test.ts tests/queue-drain-quarantine.test.ts` → 8 pass / 0 fail / 38 expect() calls across both files.

## Criterion 3 — PID-reuse heartbeat cross-check in acquireLock
**Verdict:** PASS
**Evidence:** `acquireLock` reads `heartbeatAgeMs(queueDir)` at src/indexer/queue-store.ts:208 and reclaims when `Number.isFinite(age) && age > 30_000` (line 212), even if `process.kill(pid, 0)` reports the holder PID still alive (the PID-reuse case). `bun test tests/queue-worker-slot-stale-heartbeat.test.ts` → 4 pass / 0 fail / 5 expect() calls.

## Criterion 4 — Orphan `.tmp` sweep wired into drainOnce
**Verdict:** PASS
**Evidence:** `sweepStaleTmp(queueDir, maxAgeMs = 60_000)` defined at src/indexer/queue-store.ts:115 and invoked at src/indexer/worker.ts:15 ahead of every drain iteration. `bun test tests/queue-sweep-stale-tmp.test.ts` → 5 pass / 0 fail / 16 expect() calls.

## Criterion 5 — backend/bunfig.toml preloads inline-mode setup
**Verdict:** PASS
**Evidence:** `backend/bunfig.toml` (2 lines) sets `preload = ["./tests/_setup.ts"]`; `backend/tests/_setup.ts` mirrors the root setup, defaulting `UNBROWSE_INLINE_INDEX=1` and `UNBROWSE_NO_SWEEP=1` (uses `??=` so explicit overrides win). `bun test tests/backend-bunfig-preload.test.ts` → 1 pass / 0 fail / 1 expect() call.

## Criterion 6 — Sanitizer NFC normalization
**Verdict:** PASS
**Evidence:** `sanitizeDomain` calls `domain.normalize("NFC")` at src/indexer/queue-store.ts:20 before the character-class replace at line 21. The NFC/NFD parity test in `tests/sanitize-domain-edges.test.ts` is included in the 10-pass run below.

## Criterion 7 — Windows reserved-name prefix
**Verdict:** PASS
**Evidence:** Reserved-name guard at src/indexer/queue-store.ts:28 — `/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i` matches both bare (`CON`) and dotted (`CON.example.com`) forms and prepends `_`. `bun test tests/sanitize-domain-edges.test.ts` → 10 pass / 0 fail / 10 expect() calls (covers NFC + reserved-name + safe-passthrough).

## Criterion 8 — Test baseline preserved (≥ 52 across Phase 1+1.1 surface)
**Verdict:** PASS
**Evidence:** Full surface sweep across the 16 listed files → **85 pass / 0 fail / 366 expect() calls / 16.32s**. Exceeds the 52-test plan threshold by 33. No timeouts, no skipped files.

## Criterion 9 — CHANGELOG `### fix` block under `## Unreleased`
**Verdict:** PASS
**Evidence:** CHANGELOG.md lines 1–50 show the new `### fix` block under `## Unreleased`, framed as "Phase 1.1 hardening of the disk-backed background index queue", with per-bullet severity labels (P1/MEDIUM/P2/LOW) and citation back to `docs/stateless-unbrowse-phase-1-1-followups.md`. Worker A has already landed this — no PARTIAL needed.

---

## Summary

| Verdict | Count |
|---------|-------|
| PASS | 9 |
| PARTIAL | 0 |
| FAIL | 0 |
| DEFERRED | 0 |

All nine Phase 1.1 acceptance criteria PASS against the source. The disk-backed queue is now bounded (one worker per machine), loud about silent loss (quarantine + reject reporting), safe across PID reuse, self-cleaning of orphan `.tmp` files, test-coverage-parity across `backend/`, and unicode/Windows-reserved-name safe at the sanitizer. Test baseline grew from 45 (Phase 1) to 85 across the Phase 1+1.1 surface. Phase 2 (MCP server lifecycle) is unblocked.
