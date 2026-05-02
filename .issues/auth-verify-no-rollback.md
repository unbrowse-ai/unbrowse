# Auth verify path has no rollback on partial KV failure

**Status:** OPEN. Surfaced 2026-05-02 in Slice 1, step 5 (auth-failure-modes case 8).
**Severity:** P2 — only triggers when an EdbKV write fails partway through verify;
in practice rare, but leaves orphaned `acct:` rows that block re-registration with
the same email (because `upsertUser` will reuse the existing user_id without
realizing the key never minted).

## Symptom

`GET /v1/auth/email/verify?token=…` runs four sequential, independently-fallible writes:

1. `upsertUser(env, email, { verifyNow: true })` — writes `acct:<email>` and `uid:<userId>`
2. `createLocalKey(env, email)` — writes `keyhash:<sha256>` via `storeKeyHash`
3. `bindKeyToUser(env, keyId, userId)` — writes `key2user:<keyId>` and `userkeys:<userId>`
4. `kv.put("magic:<token>", { status: "verified", api_key, user_id }, ttl: 60)`

If any of (2), (3), (4) throws after (1) succeeded, the `acct:` row is left in
storage with no associated key. Subsequent `unbrowse register --email <same>`
calls succeed at start, but `upsertUser` returns the stale row, the new
`createLocalKey` succeeds, and the new key is bound — but the user thinks they
went through the magic-link flow once and now has multiple anonymous-looking
keys for the same account.

## Root cause

`backend/src/routes/auth.ts:108-119` performs the four writes serially with no
try/catch around the chain and no compensating delete on failure. `EdbKV.put`
now throws on non-OK responses (added in the same commit as this issue),
so the failure surfaces as a 5xx — but the partial state remains.

## Test that proves it

`backend/tests/auth-failure-modes.test.ts` case 8 (currently `it.todo`).
Forces `qdkv set` to 500 only when the key contains `keyhash:`, then verifies
that `acct:` exists while `keyhash:` does not — the partial-state invariant.

## Fix options (pick one)

1. **Compensating delete chain** — wrap the four writes in try/catch; on any
   failure, delete `acct:<email>` and `uid:<userId>` if they were created
   *during this call* (track with a `createdNow` flag from `upsertUser`).
   Cost: ~20 lines in `routes/auth.ts` and `accounts.ts` returning
   `{ user, createdNow: boolean }`.

2. **Reorder writes** — mint the key FIRST (no acct dependency), then write
   `acct:` and `key2user:` last. If the late writes fail, the orphan is just
   a `keyhash:` row with no user — harmless because `bearerAuth` works without
   `key2user:`. Cost: ~5 lines in `auth.ts`.

3. **Batched put** — use `EdbKV.putBatch` to write `acct:`, `uid:`, `keyhash:`,
   `key2user:`, `userkeys:`, `magic:` in one atomic operation. Requires
   confirming `putBatch` actually has all-or-nothing semantics on qdkv (it
   appears to from the existing implementation but worth a real check).

Option 2 is the smallest and probably the right call. Reverse case 8 from
`it.todo` to `it` and assert the partial-state invariant when picked up.

## Why it's not fixed in Slice 1

Out of scope per the slice boundary. Slice 1 ships the magic-link flow with
the failure mode documented and surfaced as a 5xx (no silent corruption).
Slice 1.1 or Slice 2 should pick this up before the dashboard exposes
"my keys" since the orphaned account would confuse users browsing their list.
