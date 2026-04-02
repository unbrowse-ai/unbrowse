# Agent Harness

Read this when using the worktree capability loop skill.

Purpose:

- Codex reads this file
- Codex performs the loop itself
- helper scripts are optional convenience, not the contract
- spawned subagents are the primary judges for whether real capability cases work

## Inputs

Start from one or more of:

- GitHub issues in this repo
- a direct capability ask from Lewis
- a public URL plus intent that should become more reliable

## Base Regression Set

Always include:

- [evals/codex-cases.worktree-regression.json](../../../evals/codex-cases.worktree-regression.json)

This is the stable floor.

## Expansion Rule

Grow the working eval set when either source gives a public reproducible surface:

- issue title/body/comments mention a public URL
- capability ask names a stable product surface like GitHub search, PyPI package info, Hacker News search, npm package detail, MDN docs search

Good additions:

- public
- stable
- task-shaped
- agent-realistic
- expected fields easy to judge

Bad additions:

- auth-only unless the task is explicitly auth regression work
- flaky homepages with no concrete task
- URLs that only reproduce transient rate limits or paywalls

## Manual Loop

1. Gather context.

- If issue-driven: use `gh issue view` and relevant comments.
- If capability-driven: restate the capability in task language.
- Pull concrete URLs, intents, and expected fields from that context.

2. Build the working eval set.

- Start from the fixed base file.
- Add temporary cases for new public URLs/intents found in the issue or capability ask.
- If the new case looks like a lasting product surface, also consider promoting it into the fixed file.

3. Patch code.

- Fix root cause.
- Add regression tests where the failure mode is unit/integration-testable.

4. Spawn subagents to judge the real cases.

- Prefer one subagent per case, or small shards of related cases.
- Give each subagent:
  - the exact case ids or temporary cases it owns
  - the intent, URL, expected fields
  - the requirement to judge pass/partial/fail from real outputs, not from test assumptions
  - the requirement to report evidence: returned fields, missing fields, wrong entity type, stale data, auth wall, paywall, or replay drift
- Use the subagent result as the primary truth signal for whether the capability works.

Recommended split:

- one subagent for fixed baseline cases
- one subagent for newly added temporary cases from issue URLs / capability asks
- optionally one reviewer subagent to challenge borderline passes

5. Run Codex cold/warm product proof.

- After code changes, run the autonomous harness in benchmark mode against the working case file:

```bash
bun evals/codex-autonomous-harness.ts --benchmark --cases <working-case-file>
```

Interpretation:

- cold run = phase 0 browse/capture path
- warm run = phase 1 resolve/execute replay path

This benchmark is product-path evidence. It matters more than repo-local unit tests for this harness.

6. Run repo regressions only as secondary support.

- Minimum:
  - `bun run test:issue-regressions`
  - `bun run test`
- Add:
  - `bun test tests/cli-e2e.test.ts`
  - when the surface touches browser, auth, capture, replay, marketplace endpoint selection, or known public package/search routes

Do not let green Vitest runs override failing subagent or cold/warm product evidence.

7. If needed, run one extra targeted benchmark case.

Example:

```bash
bun evals/codex-autonomous-harness.ts \
  --benchmark \
  --intent "search hacker news" \
  --url "https://hn.algolia.com/" \
  --params '{"q":"openai"}'
```

8. Report outcome.

Include:

- what capability or issue was addressed
- what the subagents judged
- which cases passed, partially passed, or failed
- what evidence the subagents used
- which secondary regressions passed
- whether the cold/warm suite passed
- which temporary cases were added from the issue/capability context
- any residual failures that are pre-existing or out of scope

## Promotion Rule

Promote a temporary case into the fixed regression file when:

- it matches a recurring product claim
- it has failed before or is likely to regress again
- it is public and low-flake
- it covers a distinct route family not already represented

Keep it temporary when:

- it is narrow to one issue report
- the site is unstable
- the URL is a weak proxy for the real product behavior
