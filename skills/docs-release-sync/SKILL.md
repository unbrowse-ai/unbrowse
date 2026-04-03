---
name: docs-release-sync
description: >-
  Keep README, CHANGELOG, release notes, and user-facing docs aligned with shipped behavior. Use when Lewis asks to update docs after a change or prepare release-facing copy.
user-invocable: true
generated-by: history-skill-miner
design-source: ./references/first-principles-skill-design.md
---

# Docs Release Sync

Core job:

- keep the repo's user-facing narrative aligned with shipped behavior

Use this skill when:

- updating `CHANGELOG.md`, `README.md`, release notes, or launch/docs follow-on copy
- behavior, API, or install changes need user-facing docs updates
- preparing a release summary or validating docs drift

Do not use this skill for:

- internal-only refactors with no user-facing behavior change
- tagging or deploying a release without docs work
- CI triage or analytics-only work

Workflow:

1. Read the user-facing diff and the relevant docs before writing summary copy.
2. Update `CHANGELOG.md` for notable repo changes.
3. If this is a release task, follow the repo release flow and write `.release-notes.md`.
4. Align README, skill docs, and install docs with the real commands and behavior.
5. Call out any docs intentionally left unchanged so drift stays explicit.

Load-bearing constraints:

- no notable behavior change ships without docs alignment
- prefer user outcomes over implementation detail
- CHANGELOG entry required for notable changes
