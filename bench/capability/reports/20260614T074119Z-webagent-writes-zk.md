# Capability bench — Axis C (agent-driven writes) + ZK input-censoring

**Date:** 2026-06-14T07:41Z · **Binary under test:** local source (`bun src/cli.ts`)
**Witness:** `bench/capability/webagent/gate_write.sh` → **GATE PASS (exit 0, two witnesses)**

## Headline

Agent-driven **POST / PUT / PATCH / DELETE** actions now work end-to-end through the
`execute` path, and any sensitive **input** field carried in the write body is
**ZK-censored** (sha256 commitment) before it can persist to disk — while the real
value still reaches the intended target so the write actually happens.

## What changed (and why)

The prior webagent write-probe found **0/6** writes completing. Two distinct gaps:

1. **Execution** — *(fixed in the prior commit 05915f63)* a write endpoint was gated by a
   GET-oriented HEAD pre-probe that 404s on write-only routes; writes never sent.
2. **Selection / discovery** — *(this iteration)* the agent path had no way to perform a
   write without a pre-existing marketplace skill. `unbrowse run` browsed a GET and timed
   out at 38 s; `unbrowse execute` 404'd ("Skill not found") because `--method` was never
   forwarded and no ad-hoc write skill could be synthesised.

### Fix

- `cmdExecute` (`src/cli.ts`) now forwards `--method` and accepts `--body '{json}'`, and
  no longer requires `--skill` when `--url` + a write method are present.
- The execute API route (`src/api/routes.ts`) synthesises an **ad-hoc one-endpoint write
  skill** whenever the agent supplies `url + write-method (+ body)`. An explicit write
  method is authoritative and overrides any stale cached domain skill, so an agent-driven
  write is deterministic. Supplying a write method is the deliberate caller action the
  unsafe-action gate requires (`confirm_unsafe` implied) — no silent side effects.
- `buildAdhocWriteEndpoint` (`src/execution/index.ts`) builds the descriptor; the existing
  write fast-path serverFetches the real method + body.

### ZK input-censoring (the privacy invariant)

- New pure module `src/proof/input-censor.ts`: `censorInputBody` / `censorSkillForPersistence`
  replace sensitive write-body leaves (password, token, api_key, secret, … or vault-pointer
  values) with `sha256:<hex>` commitments, recording an `input_commitments` map.
- Wired at the persistence firmament in `writeSkillCache` (`src/client/index.ts`): the
  **in-memory** skill keeps the real value (process-local, used by the in-flight request);
  the **on-disk / publishable** copy carries only the commitment. The secret never crosses
  the persistence/publish boundary in clear; the reusable route shape survives (the next
  caller supplies their own value, matched against the commitment).

## Measured (live, postman-echo)

| Axis | Result |
|---|---|
| POST body reflected | PASS (×2 witnesses) |
| PUT body reflected | PASS (×2) |
| PATCH body reflected | PASS (×2) |
| DELETE body reflected | PASS (×2) |
| ZK: target received the real secret | PASS (write truly works) |
| ZK: no cleartext secret on disk | PASS (`grep -r` clean under `~/.unbrowse`) |
| ZK: sha256 commitment persisted | PASS (`"password":"sha256:…"` + `input_commitments`) |

Pre-fix evidence: `bench/capability/webagent/results-20260614T060427Z.jsonl` — every target
`cli_timeout` (38 000 ms, resolve miss). Post-fix: `gate_write.sh` exit 0.

Unit witnesses: `tests/input-censor.test.ts` (7/7), `tests/write-action-execute.test.ts`
(live POST round-trip), `tests/run-planner*.test.ts` — 24/24 green across the four files.

## Honest gaps / next

- **Authenticated (logged-in) writes** remain environment-gated: Axis C's `logged_in=false`
  depends on a real source-browser account; public write-safe targets (postman-echo) need no
  login and are what this gate proves. A logged-in-account write witness is still open.
- The ad-hoc write skill is censored at persistence but **not yet published** to the shared
  marketplace with commitments — publishing the reusable write route (commitment-only) is the
  next lever (closes the "20k sites, reusable write routes" loop).
- `packages/skill/runtime-src/` is a separate copy from `src/`; the shipped npm binary picks
  up these fixes only after a release build. This report grades **local source**, stated
  plainly (not the npm binary).
