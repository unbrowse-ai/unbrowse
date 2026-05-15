---
name: unbrowse-bench-improvement-loop
description: Run a self-improving Unbrowse bench loop. Default output is always an agent-judged bench run, a failing-probe improvement plan, bounded code fixes with focused guardrails, and a release stamp only after compare passes. Never auto-judges coverage.
---

# Unbrowse Bench Improvement Loop

## Output mode (load-bearing)

Default output is a loop state made of:

- `.bench-gate/<run-id>/judge.bundle.md`
- agent-written `.bench-gate/<run-id>/verdict.json`
- `.bench-gate/<run-id>/gate.md`
- `.bench-gate/<run-id>/improvement-plan.md` when the gate fails
- code patches plus focused regression guardrails
- `.bench-gate/stamp.json` only after agent-judged compare passes

The skill never emits deterministic PASS or FAIL verdicts. Scripts may validate schema, compare agent verdicts to thresholds, and triage failures.

## Workflow

1. Read `references/plan.md` and `references/agent-judged-contract.md`.
2. Start from clean git status. If dirty, understand and preserve unrelated changes.
3. Collect artifacts:
   ```bash
   PARALLEL=4 TIMEOUT=90 bun run bench:gate:full
   ```
4. Codex reads `judge.bundle.md` and writes `verdict.json` by inspecting artifacts.
5. Validate and compare:
   ```bash
   bun scripts/bench-gate-judge.ts --artifacts .bench-gate/<run-id> --validate
   bun scripts/bench-gate-compare.ts --artifacts .bench-gate/<run-id> --soft
   ```
6. If failing, generate the improvement plan:
   ```bash
   bun scripts/bench-improve-triage.ts --artifacts .bench-gate/<run-id>
   ```
7. Patch the root cause for the highest-leverage failing cluster. Add a focused guardrail test, but do not count that test as coverage proof.
8. Rerun the smallest meaningful probe slice, rejudge from artifacts, and repeat.
9. When full compare passes, run:
   ```bash
   bun scripts/bench-gate-compare.ts --artifacts .bench-gate/<run-id> --stamp
   ```
10. Commit the stamp and changes. Release hooks may proceed only after the stamp matches HEAD.

## Hard rules (gates)

1. No script may create an `INDEX_*` or `RETRIEVE_*` verdict except dry-run contract tests that are explicitly labeled not real.
2. Every code fix must be tied to at least one failing probe in `improvement-plan.md`.
3. Every code fix must include a focused regression guardrail when feasible.
4. Coverage proof is only agent-written `verdict.json` plus `bench-gate-compare`.
5. Hostile and auth-gated probes stay excluded only by agent verdict, not by metadata alone.
6. Do not stamp unless full compare passes.

## What This Skill Does NOT Do

- It does not bypass the prerelease bench stamp.
- It does not freeze a weaker baseline to pass.
- It does not treat unit tests as bench coverage.
- It does not decide hostile probes from lane metadata alone.
- It does not hide failures in broad summaries.

## References

- `references/plan.md` - loop goal, risks, and acceptance criteria.
- `references/agent-judged-contract.md` - index/store/retrieve/execute judging contract.
- `references/fix-loop.md` - repeatable patch cycle.
- `assets/improvement-plan-template.md` - triage output shape.
