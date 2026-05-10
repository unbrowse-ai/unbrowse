# Backend Regression Issues — 2026-04-04

Scope: regressions seen in the April 3-4 sprint affecting indexing and LinkedIn auth/keychain restore.

## 1. Background indexing can drop richer later captures

Confidence: high

Symptoms:
- indexing feels broken
- first partial browse/submit seems to win
- later `browse close` or richer capture does not fully update the domain

Why:
- [src/indexer/index.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/indexer/index.ts#L336) keeps one in-flight background index job per domain
- [src/indexer/index.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/indexer/index.ts#L352) skips any new job for that domain while one is running
- [src/api/routes.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/api/routes.ts#L936) queues background publish during browse flush
- [src/api/routes.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/api/routes.ts#L1063) triggers that flush on every `browse/submit`

Likely bad effect:
- an intermediate submit queues an incomplete index
- the final close/richer capture gets skipped as `already in flight`
- domain snapshot/cache stays incomplete

Most relevant change:
- `PR #314` / merge commit `7c726adc` on April 3, 2026

## 2. Stale cleanup can evict auth-gated/private endpoints

Confidence: medium-high

Symptoms:
- previously working indexed routes disappear or stop being reused
- private/auth-required endpoints degrade after cleanup/verification

Why:
- `PR #335` added stale cleanup and periodic sweeps
- current verification path executes GET endpoints without auth or params in [src/verification/index.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/verification/index.ts#L13)
- `c1abf09` added pruning logic in `src/stale-cleanup.ts` that removes cache entries for failed/low-reliability endpoints
- candidate selection in `c1abf09:src/verification/candidates.ts` includes failed, disabled, low-reliability, and old endpoints

Likely bad effect:
- auth-gated LinkedIn/private endpoints get re-verified cold
- they fail verification
- stale cleanup prunes local route/domain/result caches for them

Most relevant change:
- `PR #335` / merge commit `c1abf090` on April 3, 2026 at 22:22 SGT

## 3. LinkedIn/keychain cookie restore can fail because secure cookies use hardcoded CDP port

Confidence: high

Symptoms:
- LinkedIn login no longer restores cleanly from saved browser/keychain state
- cookies appear present but authenticated replay/browse does not work

Why:
- [src/kuri/client.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/kuri/client.ts#L660) tries raw CDP for secure/httpOnly cookies
- [src/kuri/client.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/kuri/client.ts#L664) hardcodes `http://127.0.0.1:9222/json`
- if Chrome/Kuri is actually on another CDP port, secure cookie injection misses the raw CDP path
- fallback path uses Kuri `/cookies`, which does not preserve secure/httpOnly/sameSite as well

Likely bad effect:
- LinkedIn `li_at` and related cookies restore incorrectly
- auth looks present but replay/browse still behaves logged out

Most relevant change:
- commit `0a7903d` on April 2, 2026

## 4. Interactive login can save a false-positive auth state

Confidence: medium

Symptoms:
- login flow says complete too early
- saved auth profile is weak/bad
- later auto-load of that profile does not actually authenticate

Why:
- [src/auth/index.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/auth/index.ts#L50) marks login as authenticated when there are any cookies on the target domain
- [src/auth/index.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/auth/index.ts#L77) accepts `cookies_present_on_target`
- on LinkedIn, target-domain cookies can exist before real authenticated completion
- [src/auth/index.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/auth/index.ts#L168) then exits login flow and stores that session

Most relevant changes:
- commit `37d328fc` on April 3, 2026
- commit `736d0de` on April 3, 2026

## 5. Auth profile save/load failures are mostly silent

Confidence: medium

Symptoms:
- auth restore appears flaky
- keychain/profile save-load drift is hard to diagnose

Why:
- [src/api/routes.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/api/routes.ts#L995) swallows `authProfileSave` failures
- [src/api/routes.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/api/routes.ts#L1001) swallows `authProfileLoad` failures
- [src/api/routes.ts](/Users/lekt9/.codex/worktrees/0f04/unbrowse/src/api/routes.ts#L1281) also swallows save failure on `browse/close`

Likely bad effect:
- if Kuri auth profile persistence drifted, the system keeps going with no useful signal

## Non-primary suspects

- `PR #342`: install/release-tarball flow; not a strong match for indexing/auth break
- `PR #344`: frontend/cache payload work; not a strong match for backend indexing/auth break

## Recommended first fixes

1. Do not queue background publish on intermediate `browse/submit`, or make queue semantics latest-wins instead of drop-on-inflight.
2. Use discovered CDP port in secure cookie injection instead of hardcoded `9222`.
3. Tighten interactive login success detection for LinkedIn-like sites; do not treat generic target-domain cookies as sufficient.
4. Add visible logging/errors when auth profile save/load fails.
