# Plan v15: Coverage gaps — see them before users do

## State of play (post plan-v13 + plan-v14)

- v6.9.69422 released, 80/80 cf+px+extract-bundle-snapshot tests green
- 4 of 7 plan-v13 BROWSER_BLOCK rows partial-flipped under residential
  proxy (2 hard PASS: footlocker/nike; 2 PASS_WEAK: indeed/hermes;
  2 still BROWSER_BLOCK: decathlon/canadagoose; 1 PRODUCT_FAIL: realtor)
- **0 live witnesses of `vendor_blocked_{cf,px}_solver_retry_success`** —
  the new solvers are wired and unit-tested but never fired in a real
  bench run. Either residential proxy hides the challenge, or the site
  serves a different vendor than predicted.
- Tier 1 cross-platform kuri builds deferred (3/4 placeholder)
- plan-v14 Tier 1.5 (skill metadata persistence) deferred

## The premise

The vendor-solver treadmill (CF → PX → Akamai → Kasada → captcha) has
decreasing ROI per site. plan-v15 stops adding solver tiers and starts
building the **observability** that would have caught all the gaps
plan-v13 surfaced — at scale, in production, automatically.

Three classes of blindness today:
1. **Empirical**: solvers ship without ever firing on a real challenge
2. **Operational**: skill drift goes undetected until a user complains
3. **Regression**: bench coverage delta between releases is invisible
   without manual `bash scripts/bench-local.sh`

## Tier 1: CI bench (~1 day, highest leverage)

**Predicted impact: regressions caught at PR time, not user-report time**

Every PR that touches `src/execution/`, `src/capture/`, `src/sandbox/`,
`src/reverse-engineer/` runs the hard-target corpus bench in CI and
posts the verdict matrix as a PR comment. Coverage delta vs main is
the structural test.

### Surface

- New workflow: `.github/workflows/bench-local-pr.yml`
  - Triggers: `pull_request` with paths-filter on the four src/ trees
  - Runs on `self-hosted` (tencent — already debloated, has bun + zig + gh)
  - `UNBROWSE_PROXY_URL` from secret (iproyal residential)
  - Steps: install + bench-local --use-source --corpus-file
    scripts/corpus/hard-target-bench.txt --timeout 120 --force-capture
    + post evidence.csv as PR comment
- Persistent artifact: `.bench-history/<commit-sha>.json` written on
  every main-branch commit by a separate post-merge workflow. Provides
  the comparison baseline.
- New script: `scripts/bench-pr-comment.ts` — diffs current run against
  most-recent main artifact, formats markdown table for PR comment.

### Decision-trace step names

NEW: none (this is a CI workflow, not runtime code).

### Falsifiers

`tests/bench-pr-comment-shape.test.sh` (~50 LoC):
- bench-pr-comment.ts emits valid markdown table
- Diff correctly identifies regressions (PASS → BROWSER_BLOCK)
- Diff correctly identifies wins (BROWSER_BLOCK → PASS)
- No-change cases produce zero-row table

### Cost

- ~150 LoC workflow + ~80 LoC TS for diff/comment
- ~50 LoC tests
- ~1 day wall-clock

### Risk

- Bench takes 25-40 min per PR — gated to relevant paths only
- Iproyal bandwidth burn — set monthly budget alert; cap to 28 URLs

## Tier 2: Skill freshness monitoring (~1.5 days, production safety net)

**Predicted impact: stale skills detected within hours of site change,
not user complaints later**

Production marketplace skills accumulate; sites change; cached
endpoints 403 / 500 / return wrong shape; today nobody notices until
a user reports it.

### Surface

- New backend Worker route: `POST /v1/internal/freshness-probe`
  - Triggered by Cloudflare Cron Trigger (every 6h)
  - Picks N=20 random "popular" skills (top by recent execution count)
  - Calls each skill's primary endpoint with `--raw`, checks status_code
  - On 403/500/empty response: marks skill as `stale_suspect`
  - On 3 consecutive stale_suspect probes: marks `stale_confirmed`,
    triggers re-capture queue + emits Slack alert
- Schema: `skills.freshness_state` enum (`fresh|stale_suspect|stale_confirmed`)
  + `freshness_last_probed_at` + `freshness_consecutive_failures`
- Re-capture queue: existing `queueBackgroundIndex` reused, just enqueued
  by cron rather than user action

### Falsifiers

`backend/tests/freshness-probe.test.ts` (~80 LoC):
- Cron-triggered probe selects N=20 skills by execution count
- 200 response → mark fresh, reset consecutive_failures
- 403 response → increment consecutive_failures, set stale_suspect
- 3 consecutive failures → stale_confirmed + queue re-capture event
- No-skills-in-marketplace case → no-op (don't crash)

### Cost

- ~120 LoC backend route + cron config + schema migration
- ~80 LoC tests
- ~1.5 days wall-clock

### Risk

- Probe traffic itself looks like bot to anti-bot vendors → use
  marketplace skills' captured cookies + libcurl-impersonate path
- Slack alert fatigue if many sites change at once → batch into single
  daily digest unless severity > 50% of probes failing

## Tier 3: Solver fixture in CI (~0.5 day, close the empirical gap)

**Predicted impact: prove `vendor_blocked_cf_solver_retry_success` and
`vendor_blocked_px_solver_retry_success` actually fire — today they're
unit-green and live-untested**

The fundamental gap from plan-v13: we have unit tests, e2e mocks, and
falsifiers — but ZERO live runs that emit `_retry_success`. CI fixture
serves a synthetic CF challenge body that ALWAYS triggers the solver.

### Surface

- Add a fixture endpoint to backend: `GET /v1/internal/_synthetic_cf_challenge`
  serves a real CF-shaped 403 challenge HTML (with valid bundle path
  to a controlled bundle file). Returns `cf_clearance` cookie when
  bundle is "executed" (we control the simulator).
- Bench harness adds one row to a separate `synthetic` corpus:
  `solve synthetic CF challenge|http://localhost/v1/internal/_synthetic_cf_challenge`
- Asserts: `vendor_blocked_cf_solver_retry_success` step appears in
  decision_trace. Same shape for synthetic PX.

### Falsifiers

Already exist as the bench-row assertion — re-using the falsifier
pattern. No new test files.

### Cost

- ~60 LoC backend fixture endpoint
- ~10 LoC corpus update + ~20 LoC bench-pr-comment.ts assertion
- ~0.5 day wall-clock

### Risk

- Synthetic differs from real CF in subtle ways (e.g. real bundle
  challenges have specific JS computation; ours can stub the cookie
  derivation). Document gap; this is a *wiring smoke* not a *behavioral
  guarantee*.

## Tier 4 [DEFERRED]: plan-v14 Tier 1.5 — skill metadata persistence

Captured CF/PX skills should embed `vendor_signals: ["cloudflare"]` +
`cf_bundle_url` so future executes can warm-start the cookie instead
of re-discovering. ~30 LoC + tests. Defer until Tier 1 (CI bench)
shows enough re-execute traffic to make warm-start measurable.

## Tier 5 [DEFERRED]: cross-platform kuri vendor

apt install libidn2-dev/zlib1g-dev for ubuntu jobs + macOS SDK env
for darwin-x64. ~1 day separate workstream. Defer until a user
actually reports broken install on those platforms (no current
demand visible).

## Tier 6 [DEFERRED]: Akamai / Kasada / captcha solvers

The plan-v13 Tier 2C analysis showed Akamai sensor_data is significantly
harder than CF/PX. canadagoose live probe also showed it's actually
Kasada (not PX as predicted). These vendors stay BROWSER_BLOCK with
honest diagnostic until either (a) a customer asks for a specific
site, or (b) Tier 1 bench shows a recurring pattern that justifies
the 2-3 day investment.

## Recommended sequence

```
Day 1   Tier 1 (CI bench)
        + scripts/bench-pr-comment.ts
        + .github/workflows/bench-local-pr.yml
        + falsifiers
        → first PR-comment delta on the next merge

Day 2-2.5  Tier 2 (skill freshness monitoring)
        + cron trigger + freshness_state schema
        + slack alert digest
        → first cron-detected stale_suspect within 6h

Day 3   Tier 3 (synthetic solver fixture)
        + synthetic CF + PX challenge endpoints
        + corpus row + assertion
        → first live `_retry_success` step in CI logs

(Reassess after T1+T2+T3. T4-T6 remain deferred as noted.)
```

## Coverage milestones

| After | Observability | What we can finally see |
|---|---|---|
| Plan-v15 today | manual bench-local only | No CI gate; no production telemetry |
| + Tier 1 | PR-time bench delta | regressions caught at PR review, not after release |
| + Tier 2 | 6h skill freshness probes | stale skills auto-flagged + queued for re-capture |
| + Tier 3 | Live solver _retry_success in CI | empirical proof CF/PX solvers actually work end-to-end |

## What this plan does NOT do

- Does not add a new vendor solver (Akamai, Kasada, captcha) — those
  are Tier 6 deferred
- Does not finish cross-platform kuri vendor (Tier 5 deferred)
- Does not ship plan-v14 Tier 1.5 skill metadata (Tier 4 deferred)
- Does not modify Kuri internals
- Does not bench against auth-gated sites
- Does not add per-domain heuristics anywhere

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bench-local-pr workflow flakes intermittently | medium | retry once on transient failure; mark flaky after 3 strikes |
| Iproyal bandwidth runs over budget | medium | cap to 28 URLs × ~5MB avg = 140MB/PR; alert at 5GB/month |
| Freshness probe traffic gets us banned from sites | medium | use captured cookies + libcurl-impersonate, throttle to 20 skills/cron |
| Synthetic solver fixture diverges from real CF | low | document as wiring smoke; production telemetry from Tier 2 catches divergence |
| Slack alert fatigue | medium | daily digest unless severity > 50% probes failing |

## Re-trigger conditions

- Tier 1 PR-comment shows ≥3 PASS→BLOCK regressions across recent PRs
  → escalate to per-merge bench instead of just PR-only
- Tier 2 detects ≥10 stale_confirmed in a week → mass site-change
  event; pause re-capture queue until investigated
- Tier 3 synthetic solver smoke fails after a Kuri upgrade → blocker
  for release; don't ship until green

## Cost summary

| Tier | LoC | Tests | Time | Predicted impact |
|---|---|---|---|---|
| T1 (CI bench) | ~230 | 4 | 1 day | catch regressions at PR time |
| T2 (freshness monitoring) | ~200 | 5 | 1.5 days | 6h stale-skill detection |
| T3 (synthetic fixture) | ~90 | reuse | 0.5 day | live solver witness in CI |
| T4-T6 [DEFERRED] | varies | — | — | Akamai/cross-plat/metadata |
| **Plan-v15 commitment (T1+T2+T3)** | **~520 LoC** | **9** | **3 days** | **Observability the solver tiers were missing** |

## Definition of done

- 1 PR per Tier (T1, T2, T3)
- Each Tier ships its own falsifier
- After T1: at least one merged PR's bench delta posts to its own PR
  comment within 30 min
- After T2: at least one cron-detected stale_suspect transitions to
  stale_confirmed and queues a re-capture
- After T3: at least one CI run emits `vendor_blocked_cf_solver_retry_success`
  AND `vendor_blocked_px_solver_retry_success` against the synthetic
  fixture
- No new per-domain code (audit grep `host === "<domain>"` in src/
  returns 0)

## Why this plan and not Akamai/Kasada/cross-plat

Plan-v13's bench evidence: 4/7 partial flips, 0 live solver witnesses,
classifier mislabels Kasada as PerimeterX in production. The gap is
**we can't see what's happening in production** — and adding more
solvers without that visibility just means we ship more wiring that
silently doesn't fire. Tier 1+2+3 close the visibility gap before
any further solver investment.

The marketplace fee splits (the OTHER plan-v14 in stash) is a
separate workstream — revenue/payments product, not coverage. It
should be its own plan when prioritized; doesn't conflict with v15.
