# unbrowse-dashboard

How Unbrowse does on its tests over time, run by run (UNB-250). A TanStack Start page on a Cloudflare Worker with D1.

Staging: https://unbrowse-dashboard-staging.lewistham9x.workers.dev (`?branch=main`, `?branch=all`).

## Where the numbers come from

| Chart | Workflow | Artifact read by `collect/parse.mjs` |
|---|---|---|
| Benchmark slice, Full benchmark | Gate bank | `gate-bank-slice-*` / `gate-bank-full-*`: `verdict.md`, `results.jsonl` (cost) |
| Agent QA | QA | `qa-report`: `qa-verdict.json`, `qa-cost.json` |
| 30 hard sites, Live-site bank | Bank | `hard-sites-report/hard-sites.json`, `bank/.../reads.md` |
| Line coverage | Coverage | `coverage-summary-*/coverage-summary.json` (`rust_all`) |
| Minutes per run | all five, with CI | the run's start and end |

QA and Gate bank call `.github/workflows/dashboard-post.yml` from their last job; CI, Coverage and Bank take pull requests or
change often, so `.github/workflows/dashboard.yml` posts them on `workflow_run`, one post per run that ended (a post
is one run's record), and the nightly `Fresh seeds` run with them (its conclusion and minutes). Pull request runs are
never posted.
The repository secret `DASHBOARD_INGEST_KEY` signs each post (HMAC-SHA256 over `<unix time>.<body>`, `src/lib/sign.mjs`).

## Commands

    bun install --frozen-lockfile
    node --test test/*.test.mjs                       # parsers, signing, the doors on SQLite
    npx tsc --noEmit && npx vite build
    node gate.mjs <url>                               # deployed: DASHBOARD_GATE_OK
    node collect/collect.mjs run <run-id> --dry       # one run's record, not posted
    node collect/collect.mjs backfill --since 2026-11-13 --post <url>   # DASHBOARD_BACKFILL_OK

Deploys ride the release train: `node .deploy/deploy.mjs staging` from the repo root (builds, migrates D1, deploys,
gates). `wrangler.vite.jsonc` is what the build reads; `wrangler.staging.jsonc` / `wrangler.jsonc` deploy its output.
