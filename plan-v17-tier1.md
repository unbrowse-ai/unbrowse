# Plan v17 Tier 1 (implementation): wire Akamai bundle-replay solver end-to-end

## Why this scope

Plan-v17 (commit `80ae1f46`) shipped the Akamai solver as a typecheck-clean stub returning `null`. Pattern is proven by CF + PX. Pre-conditions audited. The remaining work is the smallest scope path to actual bench coverage: activate the stub, add the switch arm, prove a real bench row transitions BROWSER_BLOCK → PASS.

Tier 2 (Kasada) is intentionally NOT in scope here — it has Tier 2.5 sandbox shim or `kuri.evaluateInPage` work that may need empirical iteration. Akamai is bundle-replay-only and matches CF/PX exactly. Ship the easy win first.

## Pre-conditions (HARD)

- HEAD on `feat/agent-ux-run-planner` at or after `d5bb2fa9` (plan-v17 ship)
- IPRoyal proxy secret available locally for bench-local validation: `export UNBROWSE_PROXY_URL=...`
- All 3 plan-v17 falsifiers green: `bash tests/akamai-challenge-shape.test.sh && bash tests/kasada-challenge-shape.test.sh && bash tests/plan-v17-shape.test.sh`
- Read `src/execution/cf-challenge.ts:98-184` (CF solver active body) — copy exactly, don't invent

## Scope (single PR, ~150 LoC + falsifier extension)

### Surface 1 — activate akamai-challenge.ts stub

**File**: `src/execution/akamai-challenge.ts`

Replace the stubbed `solveAkamaiAndRetry` body (currently `return null` after `void runBundleReplay`) with the real bundle-replay flow mirroring CF lines 98-184:

1. Call `extractAkamaiBundleUrl(input.body, input.url)` — already implemented
2. If null, return null (no Akamai sensor detected)
3. `globalThis.fetch(bundleUrl, { method: "GET" })` — get bundle source
4. Status check + size gate ≥1024 bytes
5. `runBundleReplay({ targetOrigin, targetHref: input.url, bundleSource, seedCookies: input.cookies, timeoutMs, proxy })` — sandbox call
6. Extract `_abck` cookie from sandbox-emitted Set-Cookie headers
7. If `_abck` missing, return null (solver self-failed)
8. Retry original request with merged cookie jar (input.cookies + `_abck` from sandbox)
9. Return `{ status, html, cookies, headers, decisionTrace }`

Keep all existing error paths (try/catch around fetch + sandbox call). Remove the `void` suppressions; the imports are now genuinely used.

**Predicted LoC**: ~80 lines added (replacing ~20 lines of stub).

### Surface 2 — wire vendor_blocked switch arm

**File**: `src/execution/index.ts`

Add Akamai arm at L2945 (after PX arm, before fallthrough at L2946). Mirror CF arm at L2873 exactly:

```ts
if (failureKind.kind === "vendor_blocked" && failureKind.vendor === "akamai_bot_manager") {
  decisionTrace.push({ step: "vendor_blocked_akamai_solver", evidence: failureKind.evidence });
  const { solveAkamaiAndRetry } = await import("./akamai-challenge.js");
  const akResult = await solveAkamaiAndRetry({
    url: <originalUrl>,
    body: <responseBody>,
    cookies: <currentCookies>,
    responseHeaders: <currentHeaders>,
    timeoutMs: 15_000,
    proxy: <proxyConfig>,
  });
  if (akResult && akResult.status >= 200 && akResult.status < 300 && akResult.html.length > 0) {
    decisionTrace.push({ step: "vendor_blocked_akamai_solver_retry_success" });
    return { trace, result: <data>, decision_trace: decisionTrace };
  } else {
    decisionTrace.push({ step: "vendor_blocked_akamai_solver_retry_still_blocked" });
  }
}
```

Exact `<originalUrl>`, `<responseBody>`, etc. variable names need to match what CF/PX pass at L2873/L2911.

**Predicted LoC**: ~25 lines.

### Surface 3 — synthetic fixture for bench-without-network

**File**: `backend/src/routes/synthetic.ts`

Add `_synthetic_akamai_challenge` route mirroring CF (L38) and PX (L55):

```ts
app.get("/_synthetic_akamai_challenge", (c) => {
  const cookie = c.req.header("cookie") || "";
  if (parseCookieValue(cookie, "_abck") === "ok") {
    return c.json({ status: "synthetic_akamai_pass", items: ["a", "b"] }, 200);
  }
  const body = `<html><script src="/akam-abc123def456.js"></script></html>`;
  return c.text(body, 403);
});
```

**Predicted LoC**: ~12 lines (handler) + 0 lines wiring (existing app.get pattern).

### Surface 4 — falsifier extensions

**File**: `tests/akamai-challenge-shape.test.sh` — extend with new assertions for the activated solver:

- Replace assertion #4 stub-status check with: `solveAkamaiAndRetry calls runBundleReplay (not just `void`)` — grep for `await runBundleReplay`
- New assertion: source file has NO `void runBundleReplay` (would indicate stub still in place)
- New assertion: source file has cookie-merge call (e.g., `mergeCookieJar` reference)

**File**: `backend/tests/synthetic-fixture.test.ts` — extend with Akamai case mirroring CF/PX assertions

**File**: `tests/akamai-bundle-replay-shape.test.sh` (NEW) — pin emitted decision-trace step names: `vendor_blocked_akamai_solver`, `_retry_success`, `_retry_still_blocked`. Mirror `tests/px-bundle-replay-shape.test.sh` (83 LoC, 5 step names).

**Predicted LoC**: ~80 LoC new tests + ~20 LoC existing falsifier tightening.

## Definition of done

- All 4 falsifiers green:
  - `tests/akamai-challenge-shape.test.sh` (12+/12+ — tightened)
  - `tests/akamai-bundle-replay-shape.test.sh` (NEW, 5+/5+)
  - `tests/kasada-challenge-shape.test.sh` (still 15/15 — untouched)
  - `tests/plan-v17-shape.test.sh` (still 19/19 — untouched)
- `backend/tests/synthetic-fixture.test.ts` extended for Akamai (4+ → 6+ cases)
- `bun test` passes for all backend tests touching synthetic
- **Manual bench validation** (the real win): `bash scripts/bench-local.sh --use-source --corpus-file scripts/corpus/hard-target-bench.txt --timeout 120 --force-capture` and inspect evidence.csv:
  - At least ONE of {nike, southwest, bestbuy, target} transitions from BROWSER_BLOCK to PASS or PASS_WEAK
  - The decision-trace for the transition contains `vendor_blocked_akamai_solver_retry_success`
- PR opened against `feat/agent-ux-run-planner`, IPRoyal secret flagged in description

## What this plan does NOT do

- Tier 2 Kasada implementation (separate plan-v17-tier2.md)
- Tier 2.5 sandbox crypto.subtle shim (deferred until Tier 2)
- Tier 4 shared utilities refactor (deferred to plan-v18 per Step 8 audit)
- Akamai inline-sensor variant (no fetchable bundle URL) — deferred; current scope handles ~80% of Akamai pages
- Per-domain heuristics — banned per CLAUDE.md ranker law
- GTM / fundraising work — orthogonal Lewis-driven track

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Akamai sensor bundle requires JS sensor execution beyond QuickJS sandbox capabilities | medium | runBundleReplay sandbox already runs CF + PX successfully; Akamai uses simpler sensor than Kasada per Step 8 audit |
| `_abck` cookie format varies across tenants → cookie gate too strict | medium | gate is presence-only (not value-validation); accepts any `_abck` value |
| IPRoyal proxy gets IP-banned during bench validation | low | residential proxy with rotation; per-row bench timeout 120s |
| nike/southwest/bestbuy/target use Akamai+second-vendor stack | medium | Tier 1 unblocks the Akamai layer; remaining vendor (if any) falls through to existing arms |
| index.ts:2945 line drift after merge | low | use `extractBundleSnapshot` symbol search instead of hard line ref when applying patch |

## Cost summary

| Surface | LoC added | LoC removed | Tests |
|---|---|---|---|
| 1. Activate akamai-challenge.ts | ~80 | ~20 (stub) | (covered by S4) |
| 2. Switch arm in index.ts | ~25 | 0 | (covered by S4) |
| 3. Synthetic fixture | ~12 | 0 | extends synthetic-fixture.test.ts |
| 4. Falsifier extensions | ~100 (NEW + tighten) | ~5 (stub assertions) | 4/4 falsifiers green |
| **Total** | **~217** | **~25** | **~80 LoC NEW tests** |

**Wall time estimate**: 1-2 days for an agent that has read CF + PX as templates.

## Validation cycle (during PR work)

After each surface lands, re-run:
```
bash tests/akamai-challenge-shape.test.sh
bash tests/akamai-bundle-replay-shape.test.sh   # after S4 lands
bun test backend/tests/synthetic-fixture.test.ts
bunx tsc --noEmit src/execution/akamai-challenge.ts src/execution/index.ts
```

After S2 lands, real bench validation:
```
export UNBROWSE_PROXY_URL=...
bash scripts/bench-local.sh --use-source --corpus-file scripts/corpus/hard-target-bench.txt --timeout 120 --force-capture
# inspect .bench-local/evidence.csv for nike/southwest/bestbuy/target rows
```

## Definition of progress (per Jesus Loop step, if invoked)

- Step 1 Light: re-read CF L98-184 + PX L52-143 to extract exact pattern
- Step 2 Firmament: name what's reusable (none — bundle-challenge-base utils deferred per Step 8)
- Step 3 Land: replace solveAkamaiAndRetry stub body
- Step 4 Luminaries: tighten akamai-challenge-shape assertions + add bundle-replay-shape falsifier
- Step 5 Creatures: synthetic fixture round-trip + adversarial cookie-jar merge cases
- Step 6 Dominion: wire index.ts arm + run bench-local on Akamai rows
- Step 7 Sabbath: verdict — did at least one row transition?
- Step 8 Judgement: 13 cold readers audit the wire-up + bench evidence
- Step 9 Emergence: PR opened on feat/agent-ux-run-planner
