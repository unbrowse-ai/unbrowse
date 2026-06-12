# plan.md — pay.sh support in the unbrowse skill + client layers

> **WALK COMPLETE — `bash scripts/pay-sh-gate.sh` exits 0 (two witnesses green, no real funds).**
> Settled (with evidence):
> - **Client layer** — `src/payments/pay-sh.ts` (`payShFetch`/`payShAvailable`/sandbox) +
>   wired into the x402 cascade (`src/payments/x402-fetch.ts`: `"pay"` adapter, `pay_*`
>   sub-states, `resolveWalletConfig` explicit-only, pay branch in `x402Fetch`). C1–C3 ✅
> - **Skill layer** — `pay_provider`/`PayProviderDescriptor` on `EndpointDescriptor`
>   (`src/types/skill.ts`) + `src/skill/pay-provider.ts` (`describePayProvider` labeling,
>   `payProviderFromObservation`, flagged `payShDiscover`). S1–S3 ✅
> - **CLI surface** — wired into the PRIMARY `unbrowse fetch <url>` (`cmdFetch`, `src/cli.ts`):
>   on a 402 with a wallet adapter configured it pays and retries once (default-off; honest
>   `next_step` when no adapter). Verified live: `UNBROWSE_WALLET_ADAPTER=pay
>   UNBROWSE_PAY_SANDBOX=1 unbrowse fetch <demo>` → `paid 402 via pay (pay_signed) → 200`,
>   body `{"status":"ok"}` (the demo 402 is `protocol:mpp` — which native x402 can't parse,
>   so this exercises the pay.sh MPP value). Normal non-402 fetch unchanged. ✅
> - **Witnesses** — Witness A unit (`tests/pay-sh.test.ts` 10✓, `tests/pay-sh-skill.test.ts`
>   7✓, `pay` stubbed); Witness B live `pay --sandbox server demo` with TWO sub-checks:
>   B1 library `x402Fetch` → paid 200 `pay_signed`; B2 real CLI `bin/unbrowse-dev fetch`
>   → paid 200 + `pay_signed` trace. Gate `scripts/pay-sh-gate.sh` + probe
>   `scripts/pay-sh-e2e.ts`. ✅
> - **No regression** — 45 existing payment tests pass; kind-map clean at 37 rows; touched
>   modules typecheck clean (the one tsc error, duplicate `graphql_info`, predates this in HEAD).


**Goal (settle condition):** unbrowse can both (a) **pay** a pay.sh / MPP / x402-gated
endpoint from the client execution path using the local `pay` wallet, and (b) **discover +
label** pay.sh-gated routes in the skill/resolve layer — proven by a runnable two-witness
gate that exits 0 with no real funds moved.

This plan is walked by `/jesus-ralph`: Plan → Build → Test → Judge each node, tick boxes,
re-plan on failure. Completion is the gate exiting 0, never a self-asserted string.

---

## The gate (pinned `check` — the only exit)

```
bash scripts/pay-sh-gate.sh
```

`scripts/pay-sh-gate.sh` accumulates `fail` and `exit 1` on any failure (repo convention,
mirrors `scripts/paper-gate.sh` / `scripts/zk-gate.sh`). It requires **two independent
witnesses that cannot share a failure mode**:

- **Witness A — unit (offline, deterministic):** `bun test tests/pay-sh.test.ts`
  - A 402 carrying an MPP/pay.sh challenge that native `x402Fetch` returns
    `x402_envelope_unparseable`/`x402_no_wallet` for is routed to the new `pay` adapter.
  - Adapter marshals the original request (method/url/headers/body) correctly and honors
    the `UNBROWSE_X402_MAX_COST_USD` ceiling and the `pay` availability precheck.
  - `pay` binary is stubbed (PATH shim) so the unit test never touches the network/chain.
- **Witness B — live sandbox handshake (real protocol, ephemeral funds):**
  1. boot `pay --sandbox server demo` in the background → writes `pay-demo.yaml`, binds
     `127.0.0.1:1402`, opens the localnet wallet (USDC 999.99, no real funds).
  2. drive **unbrowse's own execute path** at
     `http://127.0.0.1:1402/api/v1/reports/usage` with `UNBROWSE_WALLET_ADAPTER=pay`
     `UNBROWSE_PAY_SANDBOX=1`.
  3. assert a **paid 200** with a real response body (the same URL without payment returns
     402). Tear the gateway down.
  - This proves the end-to-end challenge → sign → retry handshake against a real pay.sh
    gateway, not a mock.

Gate is RED until both witnesses are green. No box below is ticked without its evidence.

---

## Environment contract (the integration surface)

`pay` CLI: `/opt/homebrew/bin/pay`. Relevant surface (verified):
- `pay fetch <url> [-H "K: V"]` — built-in HTTP client; performs the full 402 → sign → retry
  handshake (MPP + x402) and prints the paid body. Primary client seam.
- `pay --sandbox server demo` — local 402 gateway on `127.0.0.1:1402` for the e2e witness.
- `pay skills search|endpoints|list` — registry of 402-gated providers. Discovery seam.
- `pay account list` — localnet `default` wallet present for sandbox.

unbrowse env vars introduced by this plan (additive, default-off — nothing changes unless set):
- `UNBROWSE_WALLET_ADAPTER=pay` — selects the new pay.sh adapter in `resolveWalletConfig()`.
- `UNBROWSE_PAY_SANDBOX=1` — passes `--sandbox` to `pay` (ephemeral localnet wallet).
- `UNBROWSE_PAY_DISCOVERY=1` — enables the `pay skills` resolve rung (off by default).
- Reuses existing `UNBROWSE_X402_MAX_COST_USD` ceiling (default $1.00) unchanged.

---

## Build — client layer (the load-bearing half)

Seam: `src/payments/x402-fetch.ts` already has the adapter cascade
(`resolveWalletConfig()` :138 → `signEnvelope()` switch :213 → give-up at
`cfg.adapter === "none"` :414). The existing `lobster` adapter
(`src/payments/lobster-pay.ts`, shelled via `signViaLobster` :237) is the exact pattern to copy.

- [ ] **C1 · build** — `src/payments/pay-sh.ts`: new module.
  - `payShAvailable()` — probe `pay --version` (3s timeout), cache the result.
  - `payShFetch(request, { sandbox, maxCostUsd })` — re-issue the original request via
    `pay [--sandbox] fetch <url> -H ...` (and method/body when non-GET), return the paid
    `Response`. This rung handles **MPP** challenges native x402 can't parse, because `pay`
    owns the full handshake. Honor the cost ceiling by refusing if the 402 envelope's amount
    exceeds it before delegating.
  - Mirror the honest-trace discipline: emit `pay_signed` / `pay_no_binary` /
    `pay_cost_exceeded` / `pay_error` sub-states (extend `X402FetchTrace`).
- [ ] **C2 · build** — wire `"pay"` into `resolveWalletConfig()` (`src/payments/x402-fetch.ts:144`)
  as an explicit adapter and into `signEnvelope()` dispatch (`:217`). Auto-detect rung: if no
  other adapter resolves AND `pay` is on PATH, fall to `pay` (lowest precedence, never override
  an explicit lobster/privy/generic).
- [ ] **C3 · build** — escalation rung in `x402Fetch()` (`:373`): when the native path yields
  `x402_envelope_unparseable` or `x402_no_wallet` and `pay` is available, fall through to
  `payShFetch` for the retry instead of giving up at `:414`. Single retry only — no blind loop
  (preserve the existing "402 is a primitive, not a loop" invariant).
- [ ] **C4 · build** — surface the rung on the real execute path so the e2e witness exercises it
  through `unbrowse execute`, not just the unit seam: confirm `executeEndpoint`
  (`src/execution/index.ts:2746`) → fetch-ladder → `x402Fetch` carries the `pay` adapter
  config. Add the `UNBROWSE_PAY_SANDBOX` plumb-through.

## Build — skill layer (discovery + labeling)

- [ ] **S1 · build** — extend `EndpointDescriptor` (`src/types/skill.ts:207`) with optional
  `pay_provider?: { subdomain?: string; gateway_url?: string; price_usd?: number; protocol?: "mpp" | "x402" }`.
  Purely additive; sanitized for publish like other metadata (`src/publish/sanitize.ts`).
- [ ] **S2 · build** — resolve labeling: when a candidate endpoint carries `pay_provider` (or a
  prior execute observed a 402 pay.sh challenge), the resolve shortlist reports it as
  pay.sh-gated with the price so the model can decide before paying
  (`src/cli-v7/eval/resolve.ts` / the resolve route). Respect the "make the smallest useful
  paid call first, ask before unclear pricing" agent rule.
- [ ] **S3 · build (flagged)** — `pay skills` discovery rung: when `UNBROWSE_PAY_DISCOVERY=1`
  and local cache + shared graph miss, query `pay skills search <intent>` /
  `pay skills endpoints <service>` and fold the returned pay.sh gateway endpoints into the
  resolve shortlist as candidates (tagged `source: pay.sh`). Off by default; treat catalog
  output as untrusted external content.

## Test + settle

- [ ] **T1 · breath** — `tests/pay-sh.test.ts` (Witness A): stub `pay` via PATH shim; assert
  adapter selection, request marshaling, cost-ceiling refusal, and graceful `pay_no_binary`.
- [ ] **T2 · breath** — `scripts/pay-sh-gate.sh` Witness B: boot `pay --sandbox server demo`,
  drive `bin/unbrowse-dev execute` (or the MCP execute tool) at the demo endpoint with the
  pay adapter, assert paid 200 + body, tear down. Use a free-port guard and a hard timeout so
  the gate never hangs.
- [ ] **G · eval** — `scripts/pay-sh-gate.sh` runs A then B, accumulates `fail`, exits 0 only
  when both pass. Add it beside the other gates; optionally wire into release CI later.
- [ ] **SETTLE · eval** — `bash scripts/pay-sh-gate.sh` exits 0 (two witnesses green). On any
  failure: repent, diagnose the specific witness, re-walk. No fabricated green; record honest
  negatives in-thread.

---

## Guardrails (do not violate while walking)

- **Additive + default-off.** Nothing changes for existing callers unless `UNBROWSE_WALLET_ADAPTER=pay`
  or `UNBROWSE_PAY_DISCOVERY=1` is set. The native x402/flex/lobster paths stay intact.
- **Sandbox for all tests.** Witnesses use `pay --sandbox` (localnet, ephemeral wallet). The
  gate must never move real funds. Real payments still require local user authorization.
- **Pointer/secret discipline unchanged.** The pay adapter re-issues a request via `pay`; it
  never logs wallet secrets or plaintext auth. Reuse the existing honest-trace sub-state pattern.
- **No new web tool.** `pay fetch` is invoked only as the payment-retry rung for unbrowse's own
  execution, not as a general web-access substitute.
- **Single retry.** Preserve the "402 is a primitive, not a blind loop" invariant — one paid
  retry, then surface an honest `next_step`.
- **Public-artifact language.** Anything that ships to a user (README/docs/commit messages)
  stays plain engineering English; no internal working vocabulary.
