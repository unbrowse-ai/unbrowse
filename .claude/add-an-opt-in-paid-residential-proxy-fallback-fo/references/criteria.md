# Criteria: opt-in paid residential-proxy fallback on 429

Source: locked decisions in the plan state file (split arch + opt-in trigger),
recon notes below from `src/execution/index.ts` and
`backend/src/middleware/sponsor.ts` (2026-05-20).

## Recon (cited)

- **Egress side: bare `fetch()`, no undici imports.** `src/execution/index.ts`
  uses native `fetch(url, {...})` at 4 call sites: L1276, L2387, L3135, L4601.
  Server runs on bun; bun's `fetch()` natively accepts
  `proxy: "http://user:pass@host:port"` per request. No dispatcher plumbing.
  For node-runtime distributions (released CLI), `undici` is the fallback via
  `dispatcher: new ProxyAgent(url)`; the cross-runtime helper picks per
  `typeof Bun !== "undefined"`.
- **429 is already detected.** `src/execution/index.ts:3786` is the general
  `!trace.success && (status === 404 || 429 || >= 500)` branch.
  `src/execution/index.ts:3836` is the specific 429 path that today returns
  `staleEndpointResult` with a "Retry-After honored" or "back off exponentially"
  message. The paid-proxy retry attaches HERE, not as a new control surface.
- **`auth_recovery_retry` (L3585) is the structural template.** Same shape:
  detect status, retry with augmented dispatcher, log decision_trace step,
  re-stamp trace. The new feature mirrors this verbatim with `429_proxy_*`
  prefix.
- **5xx already threads `process.env.UNBROWSE_PROXY_URL`** into
  `trySsrFastPathOnBlock` (L3809). A proxy env-var pattern exists; ours adds
  the CONSENTED + METERED variant on the 429 branch.
- **Billing side: existing `kind: "sponsor"` ledger rows + per-day µ¢ counters.**
  `backend/src/middleware/sponsor.ts` exports `maybeSponsor()` returning
  `SponsorDecision = sponsored | exhausted | opted_out`. KV keys:
  `sponsor:agent:<id>:<UTC-date>` (µ¢ counter), `sponsor:global:<UTC-date>`,
  `sponsor:ledger:<row_id>`. `SponsorLedgerRow.kind === "sponsor"` with optional
  `payment_method`. EXTEND, do not parallel-path.

## Design

### Egress (in `src/execution/index.ts`, attached at L3836)

1. New helper `proxiedFetchOnce(url, init, proxyUrl)`: same call signature as
   `fetch`, dispatches through bun's per-request `proxy` option (or undici
   `ProxyAgent` on node). Lives in `src/execution/proxy-fetch.ts` (new file),
   not in `src/kuri/client.ts` (forbidden by CLAUDE.md).
2. On 429: read consent (per-request `options.paid_proxy_fallback === true`
   OR account-level KV `consent:proxy_fallback:<agent_id>` === "yes"). If
   neither, emit `429_proxy_fallback_consent_missing` and return
   `staleEndpointResult` augmented with `next_step: {kind:
   "paid_proxy_fallback_offer", suggested_command, estimated_cost_usd: 0.01}`.
3. If consented: build `proxyUrl` from `IPROYAL_USER`/`IPROYAL_PASS` env (creds
   live in memory `reference_iproyal_proxy.md`). Emit
   `429_proxy_fallback_attempted`. Retry the SAME request via
   `proxiedFetchOnce`. Capture `post_proxy_status` + `response_bytes`.
4. On post-proxy 2xx: emit `429_proxy_fallback_success`, POST a
   `recordProxySurcharge({agent_id, skill_id, endpoint_id, cost_usd:
   SPONSOR_PROXY_SURCHARGE_USD || 0.01})` to the backend sponsor endpoint,
   capture the returned `ledger_id` in the trace. Emit
   `429_proxy_fallback_billed` (or `_billing_failed` if the surcharge POST
   threw, never silently swallow).
5. On post-proxy non-2xx: emit `429_proxy_fallback_no_unblock` with status;
   DO NOT bill (no charge if proxy did not change the outcome). Return
   `staleEndpointResult` with the post-proxy status noted.
6. On proxy dial error: emit `429_proxy_fallback_error` with reason. No bill.

### Billing (in `backend/src/middleware/sponsor.ts` + a new route)

1. New exported function `recordProxySurcharge(env, {agent_id, skill_id,
   endpoint_id, ledger_id, cost_usd})`:
   - Writes a `SponsorLedgerRow` with `kind: "sponsor"`,
     `surcharge_reason: "proxy_429_fallback"` (new optional field), `amount_uc
     = Math.round(cost_usd * 1_000_000)`, `payment_method: "surcharge"` (new
     literal).
   - Increments `sponsor:proxy-surcharge:<agent_id>:<UTC-date>` counter
     (separate from the base sponsor counter so the daily cap math stays
     untouched).
   - Idempotent on `ledger_id`: re-call with same id = no double-write
     (read-before-write check).
2. New route `POST /v1/account/proxy-surcharge` (admin-key or agent-key
   gated): body `{skill_id, endpoint_id, cost_usd, ledger_id}`. Calls
   `recordProxySurcharge`. Returns the persisted row.
3. Extend `GET /v1/account/sponsor-status` response with
   `proxy_surcharge_today_usd` (sum of today's proxy lane).
4. `consent:proxy_fallback:<agent_id>` consent state read/write via a new
   `GET/PUT /v1/account/proxy-consent`.

### Decision-trace step names (per CLAUDE.md naming convention)

Following the existing `5xx_ssr_fastpath_fallback_*` pattern verbatim:

- `429_proxy_fallback_consent_missing` — 429 seen, no opt-in
- `429_proxy_fallback_attempted` — dispatched through IProyal
- `429_proxy_fallback_success` — post-proxy 2xx
- `429_proxy_fallback_no_unblock` — post-proxy non-2xx
- `429_proxy_fallback_error` — dial/network error reaching proxy
- `429_proxy_fallback_billed` — surcharge ledger row written
- `429_proxy_fallback_billing_failed` — surcharge POST failed; request still
  returned the proxied 2xx body; surface, do not silently retry

## Lanes

```yaml
lanes:
  - id: lane-recon-dispatcher
    question: "Does src/execution use bare fetch() and is bun's per-request proxy option the cleanest attach point?"
    bench_command: "grep -nE 'fetch\\(' src/execution/index.ts | head -5 && echo --- && grep -nE '\"undici\"|ProxyAgent' src/execution/index.ts || echo no_undici_imports"
    source_id: "code:src/execution/index.ts#L1276,L2387,L3135,L4601"

  - id: lane-recon-429-branch
    question: "Does the existing 429 branch at L3836 emit decision_trace steps the new fallback can extend?"
    bench_command: "zigread -L 3830-3870 src/execution/index.ts"
    source_id: "code:src/execution/index.ts#L3836"

  - id: lane-recon-sponsor-shape
    question: "Does sponsor.ts expose a writeLedgerRow + per-day counter pattern the surcharge lane can REUSE?"
    bench_command: "grep -nE 'writeLedgerRow|writeSpend|sponsor:agent:|sponsor:ledger:|SponsorLedgerRow' backend/src/middleware/sponsor.ts | head -15"
    source_id: "code:backend/src/middleware/sponsor.ts#L100-L200"

  - id: lane-tests-exist
    question: "Have the two real-endpoint failing tests landed yet (verify_command is fail-closed on these)?"
    bench_command: "ls backend/tests/sponsor-proxy-fallback.test.ts tests/proxy-fallback-429.test.ts 2>&1"
    source_id: "state:add-an-opt-in-paid-residential-proxy-fallback-fo.local.md#verify_command"

  - id: lane-iproyal-creds
    question: "Are IProyal creds available (memory note exists, env vars wired)?"
    bench_command: "ls /Users/lekt9/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/memory/reference_iproyal_proxy.md 2>&1 && env | grep -c '^IPROYAL_' || true"
    source_id: "memory:reference_iproyal_proxy.md"

  - id: lane-live-roundtrip
    question: "Does a real 429-then-proxy round-trip return 200 with a real body AND record the surcharge ledger row? (Wave 5 collector.)"
    bench_command: "test -f .claude/add-an-opt-in-paid-residential-proxy-fallback-fo/scripts/collect-roundtrip.sh && bash .claude/add-an-opt-in-paid-residential-proxy-fallback-fo/scripts/collect-roundtrip.sh || echo collector_not_yet_written"
    source_id: "plan:state#verify_gate"
```

## Failing-test specs (drafted, to land in Wave 2)

### `backend/tests/sponsor-proxy-fallback.test.ts`

Pattern: hand-rolled KV-shaped object per the existing
`backend/tests/{x402-skill-route,protected-routes-auth}.test.ts` style.
NO mocks of business logic; KV is the only seam.

1. `recordProxySurcharge` writes a `sponsor:ledger:<id>` row with
   `kind: "sponsor"`, `surcharge_reason: "proxy_429_fallback"`,
   `amount_uc: 10000` (1¢), `payment_method: "surcharge"`.
2. After 3 surcharges in a day, `sponsor:proxy-surcharge:<agent>:<today>`
   reflects 30000 µ¢ cumulative.
3. `GET /v1/account/sponsor-status` response includes
   `proxy_surcharge_today_usd === 0.03`.
4. Idempotency: `recordProxySurcharge` called twice with same `ledger_id`
   writes one row, increments the counter once.
5. The base sponsor counter (`sponsor:agent:<id>:<today>`) is UNTOUCHED by
   the surcharge path (cap math unaffected).
6. `GET /v1/account/proxy-consent` returns the consent state;
   `PUT /v1/account/proxy-consent {consent: "yes"}` persists it.

### `tests/proxy-fallback-429.test.ts`

Gated behind env vars (`UNBROWSE_LIVE_PROXY_TEST=1` + `IPROYAL_USER` /
`IPROYAL_PASS`) so CI doesn't burn proxy credits. Uses httpbin so we own the
target and the 429 is deterministic.

1. Target `https://httpbin.org/status/429`, consent NOT set:
   `executeEndpoint` returns `status_code: 429`,
   `decision_trace` contains `429_proxy_fallback_consent_missing`,
   `next_step.kind === "paid_proxy_fallback_offer"`.
2. Target `https://httpbin.org/status/429`, consent set:
   `decision_trace` contains `429_proxy_fallback_attempted`. (httpbin's 429
   is unconditional, so we then expect `429_proxy_fallback_no_unblock` and
   NO billing.)
3. Target `https://httpbin.org/ip`, consent set, force the proxy path via a
   test seam (`__forceProxy: true`): response body's `origin` IP differs
   from the direct-fetch baseline (proves the dispatcher attached),
   `decision_trace` contains `429_proxy_fallback_success` and
   `429_proxy_fallback_billed`.

## How verify.sh treats this

If `criteria.md` exists with a `lanes:` block:

1. For each lane, run `bench_command`, capture stdout to `lanes.jsonl` as
   one row: `{lane_id, ts, exit_code, output_tail}`.
2. Emit ONLY the raw `lanes.jsonl`; do not synthesize PASS/FAIL.
3. The agent (you, reading the ledger) judges whether each lane is moving.

