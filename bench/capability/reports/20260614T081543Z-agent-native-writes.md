# Capability bench — agent-native writes, write receipts, 201 fix, auto-update

**Date:** 2026-06-14T08:15Z · **Binary under test:** local source (`bun src/cli.ts`)
**Witness:** `bench/capability/webagent/gate_write.sh` (now intent-only + REST-201 + ZK)

## Headline

Writes are now **agent-native** (no HTTP verb in the call), **composable** (each write
declares `requires`/`provides` DAG edges), and **correct on real REST APIs** (201 + a
compact created body no longer mis-flagged). The client also **auto-updates** in the
background. The gate drives every write **intent-only** and passes two witnesses.

## What changed

### 1. Method-free writes (remove the knob)
`src/lib/infer-write-method.ts` infers POST/PUT/PATCH/DELETE from the intent verbs + body
presence (a body ⇒ a write). `--method` is now an override, not a requirement. The gate
exercises all four verbs purely through intent against verb-specific paths, so a
mis-inference fails there. Unit: `infer-write-method` 6/6.

### 2. Write receipt → route DAG (the "contract" done in unbrowse's own vocabulary)
A write now emits a contract-shaped receipt — **not** by shelling out to any external
ledger, but as unbrowse's own `OperationBinding`s:
- `requires` (input bindings, one per body field) are attached at endpoint-build time;
  sensitive leaves carry their **sha256 commitment**, not the value.
- `provides` (yields) — the created-resource id(s) — are parsed from the response on a
  successful write and backfilled onto the route.
Verified live (jsonplaceholder POST): persisted route carries
`requires:[title,userId]` + `provides:[id=101]`. A downstream op can now chain on the new
resource — the missing half of the DAG-recompute direction. Module: `src/lib/write-receipt.ts`,
unit `write-receipt` 4/4.

### 3. 201-write bug fix (real REST APIs)
The read-oriented `extraction_too_thin` gate was running on **write** responses: a 201 +
`{id:101}` is a correct, compact created-resource body, but was mis-flagged as a thin
extraction → `success=false`. The gate now skips write endpoints. Before: jsonplaceholder
POST → `success=false (extraction_too_thin)`. After: `success=true, status=201, id=101`.
postman-echo masked this (it echoes a large body); the witness now includes a real
201+small-body target so the regression can't return.

### 4. Background auto-update
`update-hints.ts` already checked + notified; added `shouldAutoUpdate` (pure: npm-global
only, opt-out env/CI, 12h throttle) + `maybeAutoUpdate` (detached, non-blocking
`npm i -g unbrowse@latest`, effective next run). `unbrowse upgrade` auto-applies, so the
existing SessionStart hook keeps the client current silently. Opt out:
`UNBROWSE_NO_AUTO_UPDATE=1`. Unit: `auto-update-decision` 6/6.

## Measured

| Check | Result |
|---|---|
| POST/PUT/PATCH/DELETE, intent-only (no `--method`) | PASS ×2 |
| REST-201 (jsonplaceholder, compact created body) | PASS ×2 |
| ZK: secret reaches target, no cleartext on disk, commitment persisted | PASS ×2 |
| Unit suites (infer / receipt / censor / auto-update / write-action) | green |

## Honest gaps / next
- **Authenticated logged-in writes** — still environment-gated (no real account here).
- **Marketplace publish of censored write routes** with their `requires`/`provides`
  commitments (so other agents reuse the write shape) — next lever.
- `provides` id-key heuristic is conservative (`id|*_id|uuid|slug|…`); a learned
  resource-id detector would widen yield coverage.
- `packages/skill/runtime-src` is a separate copy; the npm binary inherits these after a
  release build. This report grades local source.
