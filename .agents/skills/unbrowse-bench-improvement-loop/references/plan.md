# Day 0 Plan

## GOAL

Create a repeatable self-improvement loop that keeps fixing Unbrowse against the release-gate bench until the agent-judged gate passes.

## NON-GOALS

- No automated verdict generation.
- No release bypass.
- No baseline weakening.
- No treating unit tests as coverage proof.

## ACCEPTANCE CRITERIA

- The loop starts from live bench artifacts.
- Codex judges index, store, retrieve, and execute evidence in-thread.
- Failures produce an improvement plan with artifact paths.
- Fixes are bounded to a failing cluster and include focused guardrails.
- A stamp is written only after a full agent-judged compare passes.

## RISKS

- Overfitting one probe instead of fixing the general primitive.
- Accidentally using lane metadata as a verdict.
- Shipping with a stale stamp.
- Losing user changes while iterating quickly.

## OUT-OF-SCOPE

- Changing release thresholds.
- Reclassifying auth or hostile probes without artifact review.
- Replacing the bench judge rubric.
