# Plan v16 (revised): Finish plan-v15 Dominion — Track A only

## Why this revision
A prior draft paired the observability follow-through with a second engineering track whose source vessel turned out to be empty. Rather than fabricate a re-implementation under a "recovery" label, plan-v16 commits Track A only — A1 (CI bench wiring) and A2 (freshness real probing). See commit log for the dropped track's origin if needed.

## Pre-conditions (HARD)
- `git checkout feat/agent-ux-run-planner` before any Tier work
- Commit 99c4cd30 carries: scripts/bench-pr-comment.ts (186 LoC), tests/bench-pr-comment-shape.test.sh (9-case falsifier), backend/src/routes/synthetic.ts, backend/src/services/freshness-probe.ts (stub), backend/tests/{synthetic-fixture, freshness-probe-contract, freshness-scheduled-dispatch}.test.ts
- IPRoyal proxy secret must be set in repo: `gh secret set UNBROWSE_PROXY_URL` (flag in PR description)

## Tier A1 — CI bench wiring (~1 day, 1 PR)
### Surface
- `.github/workflows/bench-local-pr.yml` (NEW): pull_request trigger, paths-filter on `src/{execution,capture,sandbox,reverse-engineer}/**`, runs on self-hosted, runs `scripts/bench-local.sh --use-source --corpus-file scripts/corpus/hard-target-bench.txt --timeout 120 --force-capture`, then `bun scripts/bench-pr-comment.ts` to render comment, posts via actions/github-script@v7
- `.github/workflows/bench-history-write.yml` (NEW): push to main trigger, same paths-filter, writes `.bench-history/<sha>.json` back to main with `[skip ci]`
- `.bench-history/bootstrap.json` (NEW): seed baseline from current main bench
### Falsifier
- tests/bench-pr-comment-shape.test.sh already 9/9 from plan-v15 Step 4 — workflow yml itself tested by first PR
### Risk
- IPRoyal CI secret unset → flag in PR description; Lewis sets before merge

## Tier A2 — Freshness real probing (~1.5 days, 1 PR)
### Surface
- backend/src/services/freshness-probe.ts (REPLACE stub): top-N=20 via `listPopularSkills(env, 20)` from services/popularity.ts (cost-cheap — Step 8 audit found this reads an EmergentDB index cache with 30s TTL, not a raw STATS_KV scan; */15min cadence is fine), fetch via src/execution/index.ts:serverFetch, classify 200=fresh / 403/500/empty=stale_suspect, sidecar key `skill:<id>:freshness` in STATS_KV (TS type: { skillId, lastChecked, status: "fresh"|"stale"|"broken", latencyMs, httpStatus }, TTL 24h), 3 consecutive failures → stale_confirmed + queueBackgroundIndex re-capture. Idempotency: probe acquires `STATS_KV[freshness:lock]` with `expirationTtl: 60`; CF KV has no CAS so two cron firings CAN race past the lock. Last-write-wins on FreshnessRecord drops one probe's latency value when probes differ — accept the precision loss within a 60s window OR upgrade to per-probe-id append-only keys (`skill:<id>:freshness:<ts>`) trimmed by separate sweeper.
- backend/src/services/freshness-alerts.ts (NEW): postSlackAlert(entries) reads env.SLACK_WEBHOOK_URL; degrades to console.warn + KV-only when unset
- backend/src/index.ts (EDIT): scheduled handler is currently single-arm — refactor to dispatch by controller.cron with three arms ("17 */6 * * *" → existing flushQueuedGithubNotifications, "*/15 * * * *" → runFreshnessProbe, "0 13 * * *" → flushDailyDigest)
- backend/wrangler.toml (EDIT): triggers.crons grows from 1 to 3 entries
### Falsifier
- backend/tests/freshness-probe.test.ts (NEW, ~80 LoC): mock skillsKV + popularity returning 3 skills; mock fetch 200/403/500; assert sidecar updates + 3-fail re-capture-queue; non-mocking variant gated by env var
### Risk
- Probe traffic looks like bot → use captured cookies via serverFetch (already does)
- Slack webhook unset → no-op with explicit log
- Re-capture queue saturation → existing queueBackgroundIndex already caps concurrency

## What this plan does NOT do
- Second-track recovery dropped (source vessel empty)
- Cross-platform kuri (plan-v15 Tier 5) deferred
- Akamai/Kasada solvers (plan-v15 Tier 6) deferred
- No per-domain heuristics (CLAUDE.md ranker law)

## Definition of done
- 2 PRs merged (A1, A2)
- After A1: a real PR posts bench delta within 30 min
- After A2: a cron firing at */15 detects at least one stale_suspect within 7 days

## Risk register
| Risk | Likelihood | Mitigation |
|---|---|---|
| IPRoyal secret unset | high | flag in PR description; `permissions: pull-requests: write` already set on workflow |
| serverFetch IP-banned | medium | uses captured cookies + libcurl-impersonate already |
| Slack unset | low | log + KV-only |
| stash for second-track recovery later | unknown | re-issue as plan-v17 if source is located |
| **main branch protection blocks bench-history-write push** | high | audit branch protection before A1 PR; allow github-actions[bot] OR use repo PAT in `secrets.BENCH_HISTORY_TOKEN` |
| **self-hosted runner queue exhaustion** | medium | timeout + dashboard monitor; fall back to ubuntu-latest with explicit setup-bun if all 8 tencent runners busy |

## Step 5 (Creatures) findings — fix in Dominion (A1 PR scope)

- **bench-pr-comment.ts BOM blocker** (`scripts/bench-pr-comment.ts` on `feat/agent-ux-run-planner`, line 39 `parseCsv`): CSV parser does not strip UTF-8 BOM from header line. Fix: change `text.split(/\r?\n/)` → `text.replace(/^﻿/, "").split(/\r?\n/)`. ~1 LoC. Use the `﻿` escape, not the literal byte — portable across editors/VCS.
- **bench-pr-comment.ts future-schema silent loss** (`scripts/bench-pr-comment.ts` on `feat/agent-ux-run-planner`, ~lines 137–146 verdict-comparison block): missing `verdict` or non-string field on a baseline row silently treated as `delta = "="`. Fix: add `else if (typeof r.verdict !== "string" || typeof r.url !== "string") delta = "?"` before the equality check. ~2 LoC. Also guards `r.url` per Step 8 audit.
- **A2 cron-overlap idempotency lock** (`backend/src/services/freshness-probe.ts`): `*/15` probe may take >15 min on slow sites; CF Workers don't guarantee non-overlap. Acquire `STATS_KV[freshness:lock]` with `expirationTtl: 60` at probe start; if non-null, return `{skipped: "lock_held"}`. CF KV has no CAS so race is real but bounded (60s window) and FreshnessRecord upsert is idempotent at the skill level. ~5 LoC.

## Cost summary

Already shipped (Steps 3-6, on `security-conflict-review`, ready to migrate):
- bench-local-pr.yml (88 LoC, 14/14 falsifier 78 LoC)
- bench-history-write.yml (48 LoC, 16/16 falsifier 78 LoC)
- plan-v16-preflight.sh (72 LoC, 6/6 hard pass)
- plan-v16-shape.test.sh (67 LoC, 11/11 pass)

Remaining for A1 PR (~50-80 LoC): scripts/evidence-to-history.ts converter + the 3 `bench-pr-comment.ts` fixups (~3 LoC).
Remaining for A2 PR (~150-200 LoC): freshness-probe.ts replacement + freshness-alerts.ts + index.ts cron-multiplex refactor + wrangler.toml + ~80-LoC test.

| Tier | Already shipped | Still to do (LoC) | Tests still to write | Wall time |
|---|---|---|---|---|
| A1 | 4 yml/sh files + 3 falsifiers (357 LoC) | ~50-80 LoC | 0 (3 falsifiers green) | ~0.5 day |
| A2 | freshness stub + 2 contract tests (96 LoC on feat) | ~150-200 LoC | ~80 LoC | ~1.5 days |
| Total remaining | — | ~200-280 LoC | ~80 LoC | ~2 days |
