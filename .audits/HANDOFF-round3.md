# Hand-off — round 3: push, preview, staging marketplace

**Loop:** jl/default round 3 — push it, cut preview release, set up
staging marketplace with one-way prod→staging mirror.

**Filled at Day 9 (Emergence).** Skeleton below; values populated when
each thread lands.

## Thread 1 — PR push

- **PR:** [#437](https://github.com/unbrowse-ai/unbrowse-dev/pull/437) — MERGED
- **Squash commit:** `421c5387` on `origin/main`
- **Files:** `src/mcp.ts`, `src/orchestrator/resolve-race.ts`,
  `backend/scripts/{mirror-prod-to-staging.ts,STAGING-READINESS.md,staging-readiness-probe.sh}`,
  `backend/tests/mirror-prod-to-staging.test.ts`, 6 test files,
  3 ticket docs in `.audits/`
- **Test bar:** 44 pass / 0 fail in `tests/mcp-*.test.ts`

## Thread 2 — Preview release

- **Tag:** _filled at Day 6_
- **Version:** _filled at Day 6_
- **npm:** _filled at Day 6_
- **Skipped:** remote SSH smoke (use `bun run release:verify-remote` later)

## Thread 3 — Staging marketplace

- **Worker:** `unbrowse-backend-staging` on `*.workers.dev`
- **Deploy command:** `cd backend && wrangler deploy --config wrangler.ci.toml --env staging`
- **Readiness probe:** `backend/scripts/staging-readiness-probe.sh` → YELLOW (cascade payouts silently disabled, matching prod)
- **Backfill script:** `backend/scripts/mirror-prod-to-staging.ts` — operator-side, one-way invariant tested
- **Backfill runbook:** `backend/scripts/BACKFILL-RUNBOOK.md`
- **Smoke:** _filled at Day 6_

## Out-of-loop findings

- **CASCADE secret name mismatch.** `backend/src/types.ts` references
  `env.CASCADE_*`; CF stores them as `UNBROWSE_CASCADE_*`. No mapping
  layer. `isCascadeConfigured()` silently returns false in both prod
  AND staging. Payouts disabled. Match between envs — not a staging
  bug — but worth confirming whether cascade payouts are intentionally
  off or this is an unnoticed prod outage.
- **Demo-pipeline dead code.** `R2_BUCKET`, `FAL_KEY`, `TURBOBOX_URL`
  are declared required in `types.ts` but only referenced by
  `services/demo-pipeline.ts` → `routes/demos.ts` → never mounted in
  `src/index.ts`. Either mount it or relax the type to optional in a
  follow-up.
- **Frontend preview deploy red.** `Deploy Frontend Preview` job
  failed with CF API 502 on PR #437 (and the prior 5 merged PRs). A
  retry-on-5xx wrapper in `.github/workflows/preview.yml` would stop
  reddening every PR. Not blocking.
