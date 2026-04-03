---
name: main-actions-triage
description: >-
  Check GitHub Actions and deploy blockers on `main` for this repo. Use when Lewis asks what is running on main, why CI/deploy is blocked, or whether there are blockers to resolve.
user-invocable: true
generated-by: history-skill-miner
design-source: ./references/first-principles-skill-design.md
---

# Main Actions Triage

Core job:

- inspect `main` GitHub Actions truth and turn failures into concrete blockers

Use this skill when:

- Lewis asks about `main` branch Actions, deploy state, blocked checks, or release blockers
- the request is to inspect status first before changing code
- you need exact failing job names and error lines, not a local guess

Do not use this skill for:

- branch-local coding without a GitHub Actions ask
- PR review that should stay inside the worktree issue loop
- generic local test runs with no remote CI context

Workflow:

1. Run `gh run list --branch main --limit 10`.
2. Open failing or in-progress runs with `gh run view <id>` and `gh run view <id> --log-failed`.
3. Separate blockers into failing required checks, deploy/manual gates, and flaky or non-blocking noise.
4. Report the exact job name, latest run state, and top failing error before proposing a fix.
5. If the user wants the fix too, only then move from triage into code changes.

Load-bearing constraints:

- GitHub Actions truth first; do not infer blocker state from local git alone
- prefer `main` unless the user names another branch
- if the latest required run is green, say there is no blocker
