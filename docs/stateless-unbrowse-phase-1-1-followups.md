# Phase 1.1 Follow-ups — Findings from Step 8 (Judgement)

**Source:** Jesus Loop Day 8 cold-auditor review of `docs/stateless-unbrowse-plan.md` Phase 1.
**Status:** Two P1 audit findings fixed in-loop (commit pending); six findings deferred to Phase 1.1.

The audit was 13 independent read-only auditors against the post-Day-6 artifact. Fixed in-loop:
- **P1 retry-race** (Auditors #2 + #3): retry path used `writeJob(new)+deleteJob(old)` which could SIGKILL between, duplicating the job. Now uses `rewriteJobAtPath` — atomic `.tmp + rename` over the original path. Regression test `tests/worker-drain.test.ts:retry leaves EXACTLY ONE envelope on disk`.
- **P1 cli.ts spawn silent loss** (Auditor #6): `_spawnDrainWorker` lacked the entry guard + `on('error')` + `on('exit')` listeners that `index.ts` already had. Asymmetric; silent loss on `argv[1] = ""`. Now symmetric.
- **P2 CHANGELOG drift** (Auditor #9): "Inline mode default" wording inverted reality; heartbeat / sweep / 30s drain timeout omissions; second `## Unreleased` artifact (release-it merge noise — separate concern). Doc rewritten.

## Deferred — open follow-ups

### P1-1: Spawn-storm — no global `worker.lock` singleton (Auditor #5)

Under N concurrent `queueBackgroundIndex` calls from one process or M concurrent CLI invocations during the heartbeat-write cold-start gap (~200–800ms), up to N (or M) detached drain workers spawn. Per-domain `acquireLock` keeps data safe, so this is wasted spawns, not data loss. Fix: acquire `~/.unbrowse/queue/worker.lock` via `acquireLock` BEFORE `spawn()` in both `src/indexer/index.ts:queueBackgroundIndex` and `src/cli.ts:_spawnDrainWorker`. Parent should `touchHeartbeat` synchronously pre-spawn to close the cold-start gap.

### P1-2: Schema-versioning silent loss (Auditor #4)

`listJobs` silently skips files that fail `isJobEnvelope` (corrupt JSON, `version !== 1`, missing fields). `drainOnce` returns `{ processed: 0 }` indistinguishable from "queue empty." When v2 ships, all downgraded workers silently drop v2 jobs. Today: malformed files are silently dropped. Fix: extend `listJobs` to return `{ accepted, rejected: [{ path, reason }] }`; quarantine rejects to `~/.unbrowse/queue/quarantine/`; surface count in `drainOnce` return; add `unbrowse queue doctor` command.

### P1-3: Lock PID-reuse on long-uptime (Auditor #12)

`acquireLock` uses `process.kill(pid, 0)` as the sole liveness signal. On long-uptime systems (CI runners with high fork churn, macOS PID_MAX=32768) the lock-holder's PID may have been reassigned to an unrelated process. EPERM (e.g. root-owned `sshd`) is also treated as "alive" → permanent stale lock. Fix: cross-check `heartbeatAgeMs(dirname(lockPath))` inside `acquireLock` — if `alive && heartbeatAge > 30_000`, treat as stale. Two-line change.

### MEDIUM-1: Orphaned `.tmp` files accumulate forever (Auditor #3 Leak 1)

SIGKILL between `writeFile(tmpPath)` and `rename(tmpPath, finalPath)` in `writeJob` leaves `.tmp` files that `listJobs` skips but never cleans. Over years of crashes, `readdir` cost grows unbounded. Fix: in `listJobs` (or a dedicated `sweepStaleTmp` called from worker startup), `unlink` any `*.json.tmp` older than 60s.

### P2-1: bunfig cwd-bypass (Auditor #8)

`bun test` does not walk up for `bunfig.toml`. Any future invocation from a subdirectory (e.g. `cd backend && bun test`, or a CI workflow with `working-directory: backend`) silently skips the preload and would hit the real disk path during tests. `backend/` has no `bunfig.toml`. Fix: add `backend/bunfig.toml` mirroring root, OR move the env defaults into a runtime guard inside `src/indexer/index.ts` (e.g. `if (process.env.NODE_ENV === "test" || process.env.BUN_TEST) shouldRunInline = true`).

### LOW-1: Sanitizer edges (Auditor #11)

- `domain = "Ëxample.com"` NFC vs NFD produces different filenames AND different `envelope.domain` strings — listJobs returns two records for one logical domain. Real-world impact: IDN domains are punycode (`xn--`) which is ASCII-safe, so latent.
- Windows reserved names (`CON`, `PRN`, `AUX`) pass through unchanged — would hang the worker on Windows. Repo is macOS/Linux today.
- `domain = "."` produces a hidden file (leading dot); `domain = ".."` collapses to `__` silently accepting traversal-shaped input.

Fix: NFC-normalize the domain before sanitizing; reject reserved-name prefixes; reject filenames that would be `.` or `..` after sanitize.

## Acceptance audit verdict from Step 8

- **Criterion #1–#9:** verified by Auditor #10 — all PASS verdicts hold up under independent reverification (minor count drift on Criterion #5 — 42→38 tests, 160→146 expects, due to count moved across files during pruning; pass/fail unchanged).
- **API surface (Auditor #1):** PRESERVED — only additive `_processIndexJobForCli` re-export.
- **Push safety (Auditor #13):** SAFE — no upstream tracking configured; bare `git push` errors rather than ships.
- **Test honesty (Auditor #7):** 2 theatre cases noted with comments; both acceptable (test seam is documented design, e2e weak assertion is confessed in test prose).

## Phase 2 prerequisites (per `docs/stateless-unbrowse-plan.md`)

Phase 2 (MCP server lifecycle changes) should not start until:
1. The three P1 deferred items above are resolved.
2. `bench-local` is run against the disk-queue branch with inline-mode off to confirm bench rubric fields (`source`, `n_operations`, `trace_success`) are unaffected by background-indexing timing.
3. A two-week observation window in pre-prod (per the original plan's "stable for a week" note) — pinned to one of the deferred-item branches landing first.
