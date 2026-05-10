# Plan v7: Probe `status: 0` → `server` (libcurl), not `browser`

## Diagnosis (evidence from `.bench-history/20260508T222629Z/`)

Two URLs both bucketed `z_likely_browser_block_engine_error` (excluded from PASS denom). Decision-trace from `execute.out`:

**Ticketmaster** (`5_https___www_ticketmaster_com_discover_concerts_execute.out`):
```
probe   GET-1byte status=0 ms=2068
        error="ZlibError fetching ... pass `verbose: true` in fetch()"
decision strategy=browser
        reason="probe network error: ZlibError ..."
browser status=0
result  "SyntaxError: Invalid or unexpected token"
```

**Vinted** (`7_https___www_vinted_fr_catalog_search_text_nike_execute.out`):
```
probe   GET-1byte status=0 ms=2503
        error="The operation was aborted."
decision strategy=browser
browser status=0
result  "SyntaxError: Invalid or unexpected token"
```

Both: probe failed at the bun-fetch layer → ladder routes to `browser` → Kuri tab opens but returns garbage that gets parsed as JS and throws SyntaxError.

**Browser is the wrong first fallback for `status: 0`.** bun's fetch fails on ZlibError (gzip decompression) and certain TLS handshakes; libcurl-impersonate (the `server` strategy with full Chrome 131 JA4 fingerprint) handles both cleanly. Kuri tabs are for "JS-rendered page", not "HTTP layer broken".

## Fix

Single conditional change in `src/execution/probe.ts:decideFromProbe` (currently L194-199):

```ts
// OLD
if (status === 0) {
  return {
    strategy: "browser",
    reason: `probe network error: ${probe.error ?? "unknown"}`,
  };
}

// NEW
if (status === 0) {
  return {
    strategy: "server",
    reason: `probe network error (${probe.error ?? "unknown"}) — libcurl-impersonate likely succeeds where bun fetch failed`,
  };
}
```

**Surface area** (≤5 LoC):
- `src/execution/probe.ts:194-199` — flip strategy from `"browser"` to `"server"`
- `tests/execution-probe-ladder.test.ts` — extend with 2 cases (ZlibError → server, aborted → server)

**Why this works**:
1. libcurl-impersonate decompresses gzip natively; ZlibError doesn't reproduce.
2. libcurl with Chrome 131 JA4 fingerprint passes more TLS handshakes than bun's fetch.
3. If libcurl ALSO fails (vendor genuinely blocking), `classifyExecuteFailure` in the executor detects vendor markers (CF/datadome/PerimeterX) in the response body and buckets as `vendor_blocked` honestly — strictly better signal than the current "SyntaxError" stub.

## What this does NOT do

- Does not touch the Kuri SyntaxError bug itself (out of scope per CLAUDE.md "Never edit src/kuri/client.ts").
- Does not remove the `browser` strategy as a downstream fallback — Phase D's 5xx → ssr-fastpath still routes to browser/Kuri sandbox when appropriate.
- Does not add a per-domain heuristic.

## Risk

- **libcurl-impersonate slow on success**: extra ~500ms per blocked site. Acceptable; current cost is ~5s wasted on Kuri-tab + SyntaxError parse.
- **Browser was the right call for some site we haven't seen**: rare. The kind of site that NEEDS Kuri (JS-only render) usually returns a non-empty status code on probe (200 with empty body, 304, etc), not status 0. Status 0 is specifically network-layer failure.
- **Rollback**: revert the one commit. Probe behavior returns to "status 0 → browser".

## Coverage delta (predicted)

Pre: 8/9 PASS-shape on the corpus subset that's currently visible (still mid-bench).
Post: ticketmaster + vinted likely move from `z_likely_browser_block_engine_error` (BLOCK, excluded from denom) to either:
- **PASS** (`a_inspect_response_body` with real bytes) if libcurl gets through
- **honest BLOCK** (`z_likely_vendor_blocked` with vendor evidence) if not

Either way, better signal than the current SyntaxError stub. The denom changes if libcurl unblocks them; if not, the denom stays the same but the bucket is honest.

## Tests

`tests/execution-probe-ladder.test.ts` extension (2 new cases mirroring the Phase C pattern):

1. **`status:0 + ZlibError → server`**: synthetic probe `{status: 0, error: "ZlibError fetching..."}` → `decideFromProbe` returns `{strategy: "server", reason: /libcurl-impersonate/}`.
2. **`status:0 + aborted → server`**: synthetic probe `{status: 0, error: "The operation was aborted."}` → same.

Existing 401/403 + 400+text/html tests preserved (unchanged precedence in the ladder).

## Order

Single commit on `feat/agent-ux-run-planner`:
1. Flip strategy at probe.ts:194-199 (5 LoC).
2. Add 2 test cases (~30 LoC test fixtures).
3. Run `bun test tests/execution-probe-ladder.test.ts` — must be green.
4. (Optional) Re-run bench on just ticketmaster + vinted via `--only-url` to confirm bucket change before full corpus re-run.

## Definition of done

- 1 commit, independently revertable.
- 2 new probe-ladder test assertions pass.
- Single-URL bench on ticketmaster + vinted shows decision-trace `[probe status=0 → server → ...]` instead of `[probe status=0 → browser → 0/SyntaxError]`.
- Either real bytes returned (PASS) OR honest `vendor_blocked` evidence — never the SyntaxError noise again.

## What this plan supersedes

- Plan-v3's Phase B-wire (capture-time SSR fast-path integration, ~60 LoC) — that wires libcurl into capture; plan-v7 wires it into the execute decision ladder via the existing `server` strategy. Phase B-wire still relevant for the `low_quality_dom_extraction` and `no_endpoints` early-return paths in `executeEndpoint`; those are separate.

## Cost

~5 LoC + 2 tests + 1 commit. ~15 min.
