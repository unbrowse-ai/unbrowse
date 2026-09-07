# Deploy gate

## The rule

Production deploys do not happen until the platform-declared deploy-gate is satisfied. Two stages must both be satisfied before any release-it invocation reaches the npm publish or wrangler deploy step:

1. **Implementation stage.** Every deferred implementation row from the monetization architecture (PII test, domain opt-out backend, provider swap, Faremeter Flex three-recipient splits, Privy domain binding, global hold ledger, claim transfer, Tencent self-host facilitator) is marked satisfied.
2. **Benchmark stage.** The bench shows 100% pass across all seven capability dimensions (INDEX, AUTH, CSRF, SEARCH, RETR, EXEC, META).

The gate is enforced mechanically. The release flow runs `scripts/check-deploy-gate.sh` as the first `before:init` hook. If either stage is pending, the release exits non-zero before any version bump, any tag, any artifact build.

## How it composes

The gate reads a single contract row by its known id and surfaces the pending children when the gate refuses.

```
$ bash scripts/check-deploy-gate.sh
[deploy-gate] FAIL — root contract <id> status: active
[deploy-gate] blockers:
    [pending] <stage-1-id> (cell)
    [pending] <stage-2-id> (judgment)

[deploy-gate] refuse to deploy. Satisfy the gate or set DEPLOY_GATE_BYPASS=1
with a documented reason in the release commit message.
```

A new piece of work that must hold before deploy is added by spawning a child under the deploy-gate root and declaring its verify check. The release flow now refuses until that child is also satisfied. The gate composes through `parent_id` references rather than through script edits.

## Why this is in `before:init`

The release tool runs `before:init` hooks first, before any version bump, before the changelog assembly, before the tag is even computed. A failure at `before:init` means nothing observable has happened: no commit, no tag, no push, no artifact. The tree is identical to the moment before `release-it` was invoked.

This is the difference between "we caught the problem during build" (some state has changed; you have to clean up) and "we refused the action" (nothing happened; you fix the gate and try again).

## Bypass

`DEPLOY_GATE_BYPASS=1` skips the gate. The bypass is logged to stderr and the release commit message must name the reason. CI workflows for protected branches can refuse the bypass entirely; for development branches the bypass is the escape hatch when the gate's own contract platform is the thing being modified.

The bypass exists because: (1) the gate is a discipline encoded in code, not a security boundary; (2) a build host that does not have the contract platform installed cannot read the gate and would otherwise block legitimate non-monetization releases. When in doubt, do not bypass.

## What this rules out

- Releasing a version that has the monetization architecture documented in `docs/public/primitives/04` and `07` but with none of the routes implemented.
- Releasing a version that passes a narrow test suite but fails real capability dimensions on the bench.
- Forgetting that a deferred implementation row exists and shipping anyway.
- A "discipline rule" that the next release simply forgets to follow because nothing mechanically enforces it.
