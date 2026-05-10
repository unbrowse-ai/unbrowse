# Plan v14: CF challenge solver — migrate from execute → capture path

## State of play (post-plan-v13)

- Plan-v13 Tier 2A shipped: CF bundle-replay solver lives in
  `src/execution/cf-challenge.ts` + wired at
  `src/execution/index.ts:2818-2855` (the `vendor_blocked:cloudflare`
  arm of `executeEndpoint`). 13/13 unit + e2e tests green.
- v6.9.69422 released, on npm. CHANGELOG entries shipped.

## The gap (proven by bench-v13-proxy)

Plan-v13 wired the solver in the **wrong layer for the dominant flow**.

Bench against 6 plan-v13 targets WITH residential proxy
(`UNBROWSE_PROXY_URL=geo.iproyal.com:12321 country-us`):

| metric | result |
|---|---|
| cli_timeout | 0/6 (proxy got past IP-rep wall) |
| `status: browse_session_open` | 6/6 |
| `cf_solver_step` emitted | 0/6 (solver never fires) |
| endpoints captured | 0/6 |

Capture survives long enough to make a verdict, but the verdict is
"no clean endpoints" → resolve hands off via `browse_session_open`.
The CF solver is downstream of `executeEndpoint`, never reached on
cold flows.

The current solver only catches the **drift case** — a previously-
cached skill that starts 403'ing later. For the **cold-capture case**
(most real users), it's structurally invisible.

## The unlock

Move CF detection upstream. When **capture** sees a CF challenge body,
solve it inline before declaring `no_endpoints` — re-extract from the
post-clearance HTML.

Predicted unlock when residential proxy IS present:
- indeed (CF) flips to PASS
- decathlon (CF) flips to PASS
- 2-3 other CF holdouts flip to PASS
- bestbuy/canadagoose (PerimeterX) still BLOCK (Tier 2B territory)

## Tier 1: Capture-layer CF detection (~1 day, 1 PR)

### Surface

`src/capture/index.ts` — find the call site where `extractEndpoints`
returns `[]` AND the page artifact is unusable. That is where we
currently route to `auth_required` or `browse_session_open`. BEFORE
that fall-through, check for CF challenge:

```ts
import { extractCfBundleUrl, solveCfAndRetry } from "../execution/cf-challenge.js";

if (cleanEndpoints.length === 0 && responseBody) {
  const cfBundle = extractCfBundleUrl(responseBody, captured.url);
  if (cfBundle) {
    decisionTrace.push({ step: "capture_cf_solver", url: captured.url, bundle: cfBundle });
    const solved = await solveCfAndRetry({
      url: captured.url,
      body: responseBody,
      cookies: captured.cookies,
      kuriBase: process.env.KURI_BASE_URL,
      proxy: process.env.UNBROWSE_PROXY_URL,
      timeoutMs: 30_000,
    });
    if (solved && solved.html.length > 0) {
      decisionTrace.push({ step: "capture_cf_solver_retry_success", bytes: solved.html.length });
      const reExtracted = extractEndpoints({ ...input, body: solved.html });
      if (reExtracted.length > 0) {
        cleanEndpoints = reExtracted;
        skillVendorMetadata = { vendor: "cloudflare", bundle_url: cfBundle };
      } else {
        decisionTrace.push({ step: "capture_cf_solver_retry_no_endpoints" });
      }
    } else {
      decisionTrace.push({ step: "capture_cf_solver_no_clearance" });
    }
  }
}
```

### Decision-trace step names (per CLAUDE.md naming convention)

- `capture_cf_solver` — parent (challenge detected, solver invoked)
- `capture_cf_solver_skipped` — body had no CF bundle URL
- `capture_cf_solver_retry_success` — cleared HTML returned, endpoints
  re-extracted
- `capture_cf_solver_retry_no_endpoints` — cleared HTML returned but
  extractEndpoints still empty
- `capture_cf_solver_no_clearance` — solver returned null (bundle fetch
  failed / no cookie / etc.)
- `capture_cf_solver_error` — exception during solve

### Skill metadata at write time

Captured skills that hit the CF solver get tagged:

```json
{
  "vendor_signals": ["cloudflare"],
  "cf_bundle_url": "https://www.indeed.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/<hash>/main.js",
  "captured_with_solver": true
}
```

Stored on the skill JSON at write time. At execute time, the existing
`vendor_blocked:cloudflare` arm can short-circuit by reusing the stored
bundle URL instead of re-discovering.

### Falsifiers

`tests/cf-capture-shape.test.ts` (~80 LoC, 6 cases):
- Synthetic capture body with CF challenge HTML → `extractCfBundleUrl`
  matches → `solveCfAndRetry` invoked
- Synthetic capture body with no CF refs → solver NOT invoked, falls
  through
- Mocked `solveCfAndRetry` returns clean HTML → endpoints re-extracted
  AND skill tagged with `cf_bundle_url`
- Mocked `solveCfAndRetry` returns null → `capture_cf_solver_no_clearance`
  step emitted, falls through
- Mocked `runBundleReplay` throws → `capture_cf_solver_error` emitted,
  falls through
- E2E synthetic (mocked sandbox + fetch): full capture flow with CF
  challenge → endpoints re-extracted → skill written with metadata

### Cost

- ~50 LoC in `src/capture/index.ts`
- ~30 LoC in skill-write path (metadata fields)
- ~80 LoC tests
- ~1 day wall-clock + 1 PR

## Tier 2: Resolve auto-execute round-trip (~0.5 day, optional)

After capture lands a skill, resolve currently returns the shortlist
and exits. Add `--auto-execute` flag (or `UNBROWSE_AUTO_EXECUTE=1`
env var) that picks the top safe-GET endpoint and executes once. Any
`vendor_blocked:cloudflare` response triggers the existing execute-
side CF solver for the drift case.

This is the bench-friendly path. Lets `bench-local --force-capture`
also exercise post-capture execute.

### Surface

`src/cli.ts` resolve command. After capture lands, when there's a top
endpoint AND `--auto-execute` set, call `executeEndpoint(...)`. Merge
result into resolve response shape.

### Falsifiers

`tests/resolve-auto-execute.test.ts` (~40 LoC):
- Capture returns 1 endpoint → `--auto-execute` fires execute → response
  contains `executed_data`
- Capture returns 0 endpoints → `--auto-execute` is a no-op
- Without `--auto-execute`, resolve returns shortlist without executing

### Cost

- ~30 LoC in `src/cli.ts`
- ~40 LoC tests
- ~0.5 day wall-clock + 1 PR

## Tier 3: Bench harness updates (~0.25 day)

Update `scripts/bench-local.sh` to pass `--auto-execute` when
`--force-capture` is set, and update the verdict classifier to count
`captured + executed_with_data` as PASS rather than just
`has_available_operations`.

### Cost

- ~15 LoC in `scripts/bench-local.sh`
- ~20 LoC in `bench-local-triage.py`
- ~0.25 day wall-clock

## Recommended sequence

```
Day 1   Tier 1 (capture-layer CF detection)
        + tests/cf-capture-shape.test.ts
        + skill metadata fields
        bench-local --force-capture --proxy → expect indeed/decathlon flip

Day 1.5 Tier 2 (resolve auto-execute) — only if bench needs it

Day 2   Tier 3 (bench harness updates)
        full bench-v14 against same 6 plan-v13 targets with proxy
        record coverage delta in plan-v14.md "Smoke Results"
```

## Coverage milestones

| After | Cold-capture CF coverage |
|---|---|
| Plan-v13 (today) | 0% on cold flows |
| + Plan-v14 Tier 1 | ~50-75% on CF cohort with proxy |
| + Plan-v14 Tier 2+3 | bench can verify end-to-end |
| + Plan-v13 Tier 2B (PerimeterX) | separate workstream |

## What this plan does NOT do

- Does not touch PerimeterX, Akamai, or DataDome paths — plan-v13
  Tier 2B/2C workstreams
- Does not move OTHER vendor solvers into capture (none exist yet)
- Does not change kuri-vendor.yml CI workflow — still needs manual
  `workflow_dispatch` to land real binaries
- Does not require deleting the existing execute-side solver — both
  layers stay; capture catches cold flows, execute catches drift
- Does not add per-domain branches (CLAUDE.md ranker philosophy)

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Solver succeeds at capture but cleared HTML still has no extractable endpoints | medium | Explicit `_retry_no_endpoints` step name; handle as "challenge solved but page genuinely empty" |
| Solver hangs in capture path, blocking resolve | medium | `solveCfAndRetry` timeout (30_000ms default); plumbed through |
| CF rotates challenge format, regex drifts | medium | Existing 9 plan-v13 unit tests; bench-v14 adds e2e canary |
| Bundle fetch ignores `UNBROWSE_PROXY_URL` (known plan-v13 minor bug) | low (bundle is public CF asset) | Document; fix in T1.5 if observed |
| Capture latency doubles for non-CF sites | low | Detector is pure regex, no I/O unless match |

## Re-trigger conditions

- New CF site flips PASS→BLOCK → check if `cf_bundle_url` changed
- `capture_cf_solver_retry_no_endpoints` rate above 30% → post-clearance
  pages may need different extractor (not this plan's scope)
- Non-CF vendor (PerimeterX, DataDome) follows same pattern → Tier 2B/
  2C plans get the migration treatment

## Cost summary

| Tier | LoC | Tests | Time | Predicted unlock |
|---|---|---|---|---|
| T1 (capture-layer detection) | ~80 | 6 | 1 day | +2-4 sites flip BLOCK→PASS |
| T2 (auto-execute) [OPTIONAL] | ~30 | 3 | 0.5 day | +bench end-to-end witness |
| T3 (bench harness) | ~35 | — | 0.25 day | +ongoing regression detection |
| **Plan-v14 commitment (T1)** | **~80 LoC** | **6** | **1 day** | **+2-4 sites** |

## Definition of done

- 1 PR per Tier (T1 mandatory; T2/T3 optional follow-ups)
- `tests/cf-capture-shape.test.ts` ships with T1, all green
- bench-v14 against 6 plan-v13 targets with `UNBROWSE_PROXY_URL` set
  shows ≥2 BLOCK→PASS flips with `capture_cf_solver_retry_success` in
  decision_trace
- No regression in cf-challenge.test.ts / cf-challenge.e2e.test.ts
- audit grep `host === "<domain>"` in src/ still returns 0
