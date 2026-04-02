---
name: worktree-capability-loop
description: >-
  Repo-local capability expansion workflow for the current git worktree. Use
  when asked to fix GitHub issues, add more product capabilities, or tighten
  regressions in this repo with gh CLI and Codex. Primary mode is a read-only
  harness document that Codex reads and performs manually: gather context,
  expand the eval set on the fly from issue URLs or capability asks, spawn
  subagents to judge whether real cases work, and rerun a Codex cold/warm
  regression suite before handoff.
user-invocable: true
---

# Worktree Capability Loop

Use this skill inside the current repo worktree when the task is:

- fix specific GitHub issues with `gh`
- add or harden product capabilities even when no issue exists yet
- gather issue bodies/comments into a local artifact before coding
- turn issue URLs or capability asks into extra eval cases when they map to public reproducible surfaces
- use subagents as the primary product-truth judge for those cases
- run a fixed Codex cold/warm regression set after the fix
- optionally run one extra targeted Codex eval for the touched surface

Primary contract:

- Read [references/agent-harness.md](./references/agent-harness.md).
- Treat that file as the harness Codex should follow.
- Do not treat the helper script as the main product contract.

Optional helper only:

```bash
bun run issue:worktree:collect -- --repo unbrowse-ai/unbrowse --issue 69
bun run capability:worktree:collect -- --capability "add PyPI package support"
```

Notes:

- Run from the repo root of the active worktree.
- Uses `gh` only for GitHub issue context; capability-only mode does not need GitHub at all.
- Default verification is Codex-owned product checks first. Repo tests are secondary support signals, not the primary truth contract for this skill.
- The eval set is intentionally expandable. Public URLs named in issues and recognized capability asks should become temporary or permanent cases in the post-fix proof set.
- The helper script is optional deterministic orchestration only. Preferred path: Codex reads the harness doc and performs the loop itself.

Script:

- [scripts/issue-worktree-loop.ts](./scripts/issue-worktree-loop.ts)
