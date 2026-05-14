# PR #437 — Deploy Frontend Preview failure audit

Run: https://github.com/unbrowse-ai/unbrowse-dev/actions/runs/25744264777/job/75603226650
Workflow file: `.github/workflows/preview.yml` (job `deploy-preview` / step "Upload Cloudflare preview version", line ~167-180)

## Root cause

Cloudflare Workers API returned **502 Bad Gateway (HTML error page)** to
`wrangler versions upload` (via `opennextjs-cloudflare upload --preview-alias pr-437`):

```
GET /accounts/***/workers/services/frontend-experiments -> 502 Bad Gateway
ERROR  Received a malformed response from the API
```

(Log timestamps 2026-05-12T15:25:21.5Z, run 25744264777.)

This is a **transient Cloudflare API outage**, not a repo / secret / build
problem. The build step succeeded; only the upload to CF Workers failed.
Cloudflare returned an HTML 502 page where wrangler expected JSON, so
wrangler exit 1. Re-running the job would likely pass.

Secondary warning ("Multiple environments are defined... no target
environment was specified for the versions upload command") is benign —
this same warning fires on every successful run too.

## Is it blocking merge of #437?

**No.** Evidence:

1. `gh pr view 437 --json mergeStateStatus,mergeable` returns
   `mergeStateStatus: UNSTABLE`, `mergeable: MERGEABLE`. `UNSTABLE` means
   "has failing checks but they're not required" — GitHub will allow the
   merge. (`BLOCKED` would prevent it.)
2. Every recent merged PR to main has the same `Deploy Frontend Preview`
   = FAILURE check and was merged anyway:
   - PR #436 (merged) — Deploy Frontend Preview FAILURE, run 25691544808
   - PR #435 (merged) — Deploy Frontend Preview FAILURE, run 25635119407
   - PR #433 (merged) — Deploy Frontend Preview FAILURE, run 25617899398
   - PR #431 (merged) — Deploy Frontend Preview FAILURE, run 25603408606
   - PR #430 (merged) — Deploy Frontend Preview FAILURE, run 25602369162
3. Branch-protection API on `main` returns HTTP 403 ("Upgrade to GitHub
   Pro or make this repository public to enable this feature"). The repo
   is on a tier that cannot enforce required-check rules via API, so the
   preview check is informational only.
4. The job is a **deploy** (not a build-gate). It uploads a preview
   version to Cloudflare Workers for human/agent review of the PR's
   frontend — purely cosmetic for merge purposes. The build step that
   actually validates frontend compiles (`Build frontend for preview`)
   ran successfully before the upload step failed.

## Action

Proceed to `gh pr merge 437 --squash` once the in-progress required
checks (Unit Tests, Quality Gate, Backend Tests, Typecheck Backend, CLI
E2E, Package CLI, Landing Funnel E2E, Resolve Preview Context, Repo
Sanity) come back green. The Deploy Frontend Preview red X can be
ignored.

No workflow file modifications required.

## Follow-up (optional, separate ticket)

Wrangler `versions upload` should specify `--env experiments` explicitly
(the warning suggests this), and the step could be wrapped with a retry
on 5xx-from-CF to absorb transient API outages without painting every PR
red. Neither is on the critical path for #437.
