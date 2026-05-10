# Plan v4: Phase C — Probe-Gate Extend to 400+text/html

**Premise**: footlocker.com/category/men/shoes.html is the only PRODUCT_FAIL with sc=400 + text/html on the hard-target corpus. Probe-gate routes 401/403 to `server` strategy (commit `a9c0ad58`) but 400 still short-circuits to `return-error`, synthesizing a stub. Survey-style direct fetches show many sites reject HEAD with 400 but accept GET. One conditional in `decideFromProbe` routes 400+html → `server`, lets serverFetch + classifier decide.

**Current state**: PASS=7, PROD=2, BLOCK=22, denom=9, **coverage=77.8%**.
**After Phase C**: footlocker PROD → PASS, denom unchanged at 9, **coverage=8/9=88.9%**.

## What this plan replaces

`plan-v3.md` Phase C section. This is the executable continuation as a standalone bounded patch. Phases B-wire (survey done, helper exists, ~60 LoC integration), D (foundation done, opportunistic), E/F deferred. Phase C is the smallest atomic remaining win.

## Patch

### Surface area: `src/execution/probe.ts:decideFromProbe`

Current code (lines 162-178 region):
```ts
// 401/403 — fetch full body via server-fetch (added a9c0ad58)
if (status === 401 || status === 403) {
  return {
    strategy: "server",
    reason: `probe status ${status} — fetch body for vendor-block classification`,
  };
}
// Other 4xx/5xx — return-error short-circuit
if (status >= 400) {
  return {
    strategy: "return-error",
    reason: `probe status ${status}; returning to caller`,
  };
}
```

New branch (insert AFTER 401/403, BEFORE the catch-all 4xx/5xx):
```ts
if (status === 400 && /text\/html/i.test(content_type)) {
  return {
    strategy: "server",
    reason: `probe status 400 + text/html — HEAD often rejected for non-browser UA, GET often succeeds`,
  };
}
```

### Why text/html gate

Real API errors return `application/json` for 400 (`{"error": "missing_param", ...}`). When a 400 carries `text/html`, the response is almost certainly a soft-block UI page, not a structured rejection. The gate prevents wasted retry on legitimate API errors while activating fallback on UA-rejected GETs.

### Why this works for footlocker

Footlocker's HEAD probe returned `400 text/html; charset=utf-8` per `.bench-history/20260508T133048Z/`. Their backend rejects HEAD on this UA but accepts GET (mirroring the cdiscount pattern from prior loops where HEAD-403 → GET-200 succeeded).

## Surface

| File | Change | LoC |
|---|---|---|
| `src/execution/probe.ts` | New branch in `decideFromProbe` | 6 |
| `tests/execution-probe-ladder.test.ts` | 2 new assertions | ~30 |

## Tests

`tests/execution-probe-ladder.test.ts` extension (one happy + one over-trigger guard):

1. **`400 + text/html → server strategy`**: synthetic probe returning 400 + `text/html; charset=utf-8` → `decideFromProbe(...)` returns `{ strategy: "server", reason: /400.*text\/html/ }`. Proves the new branch fires.
2. **`400 + application/json → return-error preserved`**: synthetic probe returning 400 + `application/json` → `decideFromProbe(...)` returns `{ strategy: "return-error" }`. Proves we don't over-trigger on real API errors.

(Also adjacent regression: existing 401/403 test cases must still pass — the new branch must come AFTER 401/403 in `decideFromProbe` so its precedence is right.)

## E2E

After patch + test pass:
1. `bash scripts/bench-two-phase.sh --corpus /tmp/footlocker_only.txt --use-source` — single URL run
2. Decision trace expectation: `[probe HEAD 400 text/html, decision strategy=server, server_fetch status=?]`
3. If server_fetch returns 200 with real product page → PASS verdict, Phase C delivers
4. If server_fetch ALSO 400/non-200 → footlocker's GET is also blocked; Phase C structurally correct but doesn't unlock this site (the `text/html` gate may need to extend further OR the bench classifier wires the response through Phase A's empty-200 / classifier branch). Either outcome is honest.

## Risk + rollback

- **False activation**: a real API that returns `text/html` for 400 (rare — APIs almost always serve JSON for errors) wastes 200ms on a redundant GET. Acceptable; bounded by the 90s phase2 timeout.
- **Real validation errors hiding behind text/html**: e.g. a site renders a "missing parameter" page in HTML. The full-body GET would surface that page; the bench classifier (Phase A) would bucket as `a_inspect_response_body` for agent judgment. No worse than current `return-error` stub.
- **Rollback**: revert the single commit. Probe behavior returns to `return-error` for all 4xx not 401/403.

## Order

Single commit. Run-test-commit-push-bench in one pass (~30min). After Phase C lands, re-run the full hard-target bench to confirm:
- footlocker either PASS (real product page returned) or stays as PROD with cleaner verdict (full body in `phase2_response_excerpt` for agent to inspect)
- No regression: the other 30 URLs preserve their current bucket

## Out of scope

- Phase B-wire (capture-time SSR fast-path integration, ~60 LoC) — separate iteration; survey done, helper + Kuri-share already in place
- Phase D coverage activation — depends on walmart actually 5xx-ing again (non-deterministic) OR another corpus site 5xx-ing
- Phase E/F (long-tail BROWSER_BLOCK + bundle-replay solver)
- README / CHANGELOG — bench-only behavior; no public-API change

## Definition of done

- 1 commit on `feat/agent-ux-run-planner`
- 2 new test assertions pass; 14 existing probe-ladder tests still green (current state has 1 pre-existing fail unrelated to Phase C — verified, not my regression)
- `.bench-history/<runid>/` shows footlocker's bucket changed from `a_inspect_response_body` (sc=400) to either PASS or to a more useful classifier output
- Coverage tally on the existing run reaches **at least 8/9 = 88.9%**, target 100% if walmart 5xx's during the bench
