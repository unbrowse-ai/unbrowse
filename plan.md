# Plan: Bundle-Replay in Execute Path

**Goal**: turn `vendor_blocked` BROWSER_BLOCK → PASS for sites whose challenge can be solved by replaying the vendor's JS bundle in a sandboxed VM. The infrastructure already exists; this plan wires it into `executeEndpoint`.

**North star**: cdiscount, leboncoin, glassdoor, indeed, ticketmaster, vinted, g2 — currently honest BROWSER_BLOCK after the probe-gate + classifier work — become PASS without opening a real browser. Each vendor unlock multiplies coverage on the long tail of sites that share that vendor.

## Why this is solvable now

Three components already exist in the codebase:

1. `src/sandbox/bundle-replay-client.ts:runBundleReplay` — Kuri `/v1/sandbox/replay` client. Takes target origin, bundle URL/source, seed cookies, fingerprint. Returns computed cookies + observed routes + post-eval result.
2. `src/execution/index.ts:extractBundleSnapshot` — companion to `detectBrowserBlockSignals`. When capture detects a vendor signal, this packages the bundle URLs into `captured_meta.bundle_snapshot` on the skill manifest.
3. `src/execution/index.ts:classifyExecuteFailure` (this loop) — runs at execute time, identifies the vendor when libcurl replay 403s.

Missing seam: in the `vendor_blocked` branch at line ~2715, when we identify a vendor we already gave up. Instead, we should attempt bundle replay first.

## Scope

**In scope** (this plan):

- One vendor: **Cloudflare `cf_clearance`** as the first wire-up. Most prevalent, well-documented, lowest false-negative risk.
- One code path: `executeEndpoint`'s vendor_blocked branch.
- One retry: bundle-replay → inject computed cookies → re-run `serverFetch`. If still 4xx, return honest `vendor_blocked` next_step.
- Tests: real CF challenge body fixture + a sandbox-replay mock that returns `cf_clearance=...` (the `runBundleReplay` boundary is already mockable).

**Out of scope** (future iterations):

- DataDome solver — needs `c.js` from `captcha-delivery.com` to be packaged into the bundle snapshot at capture time. Today's `extractBundleSnapshot` may not capture this; verify before extending.
- PerimeterX, Akamai `_abck`, Imperva `reese84`, Kasada — each needs vendor-specific handling.
- Captcha-gated sites (hCaptcha, reCAPTCHA) — never solvable without paid solver or human; stays BROWSER_BLOCK.
- Chained challenges (CF → DataDome). One-step replay only.

## Architecture

```
                     ┌──────────────────────────────────────┐
                     │ executeEndpoint (line 2599 onwards)  │
                     │   serverFetch → 403                  │
                     │   auth-recovery chain → fails        │
                     │   classifyExecuteFailure({status,    │
                     │     body: rawFailureBody}) →         │
                     │     {kind: vendor_blocked,           │
                     │      vendor: cloudflare}             │
                     └──────────────────────────────────────┘
                                       │
                                       ▼
                     ┌──────────────────────────────────────┐
                     │ NEW: tryVendorBundleReplay(           │
                     │   skill, endpoint, vendor, cookies,   │
                     │   authHeaders)                        │
                     │                                       │
                     │ 1. read skill.captured_meta           │
                     │     .bundle_snapshot                  │
                     │ 2. if empty → no_bundle_snapshot      │
                     │     return null                       │
                     │ 3. runBundleReplay({                  │
                     │     targetOrigin, bundleUrl,          │
                     │     seedCookies: cookies,             │
                     │     fingerprint: chrome131            │
                     │   })                                  │
                     │ 4. merge resp.cookies into cookies    │
                     │ 5. serverFetch() retry                │
                     │ 6. return retry result                │
                     └──────────────────────────────────────┘
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                ┌─────────────────────┐   ┌─────────────────────┐
                │ retry succeeded     │   │ retry still 4xx     │
                │ (status 200)        │   │                     │
                │ → trace.success     │   │ → vendor_blocked    │
                │ → return data       │   │   honest next_step  │
                └─────────────────────┘   └─────────────────────┘
```

## Bounded tasks

1. **Verify bundle_snapshot reaches the skill manifest at execute time**
   - Read `src/execution/index.ts:1099` (`extractBundleSnapshot` call site at capture)
   - Confirm `bundle_snapshot` lands in published skill's `captured_meta`
   - If yes → proceed to step 2
   - If no → first close that gap before wiring replay

2. **Add `tryVendorBundleReplay()` helper**
   - Location: `src/execution/index.ts` near `classifyExecuteFailure`
   - Inputs: skill, endpoint, vendor name, current cookies, current authHeaders
   - Reads `skill.captured_meta?.bundle_snapshot`
   - Returns `{ ok: true, cookies: SandboxCookie[], data: unknown, status: number } | { ok: false, reason: string }`
   - Calls `runBundleReplay` with timeoutMs=15000 (don't tank execute on dead Kuri)

3. **Wire into vendor_blocked branch**
   - Location: `src/execution/index.ts:~2715` (`if (failureKind.kind === "vendor_blocked")`)
   - Attempt replay only when vendor is in supported set: `["cloudflare"]` for v1
   - On replay success: rewrite `data`, `status`, `trace.error`, `trace.success = true`, `decisionTrace.push({step:"bundle_replay", vendor, status})`
   - On replay failure: keep current honest `vendor_blocked` next_step, append `bundle_replay_failed: <reason>` to message

4. **Don't loop**
   - Replay runs once. If retry still 403/captcha → vendor_blocked stays.
   - No retry-after-recovery → bundle-replay → retry. Single attempt, single retry.

5. **Tests**
   - `tests/bundle-replay-execute.test.ts`: 4 assertions
     - vendor=cloudflare with bundle_snapshot present + mocked `runBundleReplay` returning `cf_clearance` → retry called with merged cookies → assertion on retry input
     - vendor=cloudflare without bundle_snapshot → no replay attempted → vendor_blocked preserved
     - vendor=datadome (not in supported v1 set) → no replay attempted → vendor_blocked preserved
     - replay throws / timeouts → caught, vendor_blocked preserved with `bundle_replay_failed` evidence
   - Mock the `runBundleReplay` import boundary, not the inner sandbox

6. **E2E proof**
   - Pick one CF-fronted site from the bench corpus that currently BROWSER_BLOCKs (glassdoor or g2)
   - Capture fresh skill (force a new intent string for new skill_id)
   - Run execute, confirm decision_trace shows `bundle_replay → server_fetch 200`
   - Snapshot the result body to confirm real data flowed back

## Decision points (require explicit answer before implementation)

**A. Does Kuri sandbox `/v1/sandbox/replay` actually solve CF's challenge today?**
- Run a smoke test: `unbrowse fetch https://www.glassdoor.com/Reviews/index.htm` and see if cookies come back
- If yes → wire-up confidence high
- If no → infrastructure exists but doesn't actually solve CF; need to add VM-side support OR pivot to a different first vendor

**B. What does `bundle_snapshot` look like for CF sites?**
- Inspect a captured skill's `captured_meta.bundle_snapshot` for a CF site
- It must include `cdn-cgi/challenge-platform/h/g/orchestrate/jsch` URLs OR similar
- If empty → capture-time `extractBundleSnapshot` doesn't recognize CF; first task becomes "extend extractBundleSnapshot to capture CF challenge URLs"

**C. Does the Kuri sandbox runtime have what CF expects?**
- CF challenge JS sniffs: navigator.webdriver, canvas fingerprint, audio context, performance.now jitter, plugins, language, timezone
- Kuri sandbox docs/source must be checked: do these APIs exist with believable values?
- If no → bundle replay will compute the wrong cookie and CF will still 403

## Definition of done

- One CF-fronted site from the hard-target corpus moves from BROWSER_BLOCK → PASS in `bench-two-phase.sh` with the marketplace wiped (anti-cheat preserved).
- Decision trace shows: `probe → server → server_fetch 403 → bundle_replay (cloudflare) → server_fetch 200`.
- 4 unit tests green.
- No regression on the existing 31 classifier tests + 13 bench-picker tests.
- `bench-history/COVERAGE-SNAPSHOT-2026-05-08.md` updated with new coverage tally.

## Risk + rollback

- **Risk 1**: bundle replay computes wrong cookies → CF returns the same challenge → infinite loop. **Mitigated** by single-attempt design (step 4).
- **Risk 2**: Kuri sandbox unavailable → execute hangs. **Mitigated** by 15s timeout in `runBundleReplay`.
- **Risk 3**: false-positive vendor classification triggers replay on a normal 403 → wastes Kuri cycles. **Acceptable** — single attempt, 15s cap.
- **Rollback**: revert one commit; vendor_blocked branch returns to honest-no-attempt behavior. The classifier itself is unaffected.

## Out-of-scope follow-ups (named, not committed)

- DataDome solver: needs `extractBundleSnapshot` to capture `captcha-delivery.com/c.js` and Kuri sandbox to handle DataDome's anti-VM checks
- PerimeterX `_pxhd` computation
- Multi-vendor chained replays (CF challenge → DataDome → final 200)
- Bundle-replay caching: same site, same fingerprint → cache the computed cookie for N minutes
- Per-vendor success-rate metrics on `.bench-history/`

## Reference

Existing modules:
- `src/sandbox/bundle-replay-client.ts:runBundleReplay`
- `src/sandbox/bundle-replay-client.test.ts` — 4 tests, see for mocking pattern
- `src/execution/index.ts:extractBundleSnapshot` (line ~3290)
- `src/execution/index.ts:classifyExecuteFailure` (line ~3282, this loop)
- `src/cli.ts:runSandboxCore` (line ~2137) — existing fetch-command wire-up; mirror its mechanics

Bench corpus: `scripts/corpus/hard-target-bench.txt`. CF-fronted candidates: g2.com, similarweb, indeed, glassdoor, ticketmaster.
