---
name: history-skill-miner
description: >-
  Mine local Codex chat history for repeated workflows and turn them into
  narrow repo-local skills using the
  `first-principles-skill-design` contract. Use when Lewis asks to promote
  repeated chat patterns into skills, refresh generated skills, or register
  them in `AGENTS.md`, or export the useful skills plus their dependencies for
  sharing.
user-invocable: true
---

# History Skill Miner

Core job:

- turn repeated chat workflows into repo-local skills with tight trigger contracts

Use this skill when:

- Lewis asks to make skills out of repeated past-chat workflows
- the generated skills should come from local Codex history, not guesswork
- `AGENTS.md` should be updated to point at the miner and the emitted skills
- the miner and generated skills should be bundled for reuse in another repo or agent host

Do not use this skill for:

- designing one manual skill from a single prompt
- mining public product analytics or website traffic instead of chat history
- emitting overlapping skills without checking existing local skills first

Workflow:

1. Read [first-principles-skill-design.md](/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/skills/history-skill-miner/references/first-principles-skill-design.md).
2. Run `bun skills/history-skill-miner/scripts/mine-history.ts`.
3. Review [generated-skills.md](./references/generated-skills.md).
4. Keep only skills with one core job and explicit non-triggers.
5. If the skills should be shared, run `bun skills/p2p-skill-share/scripts/share-bundle.ts --mode quick --print-only` or switch to named mode.
6. Ship the miner, generated skills, `AGENTS.md`, and `CHANGELOG.md` together.

Load-bearing constraints:

- default history sources: `~/.codex/history.jsonl`, `~/.codex/session_index.jsonl`, `~/.codex/archived_sessions/*.jsonl`
- generated skills must follow the first-principles contract: one core job, positive triggers, explicit non-triggers, shortest viable workflow
- skip or tighten any candidate that overlaps an existing local skill
- `AGENTS.md` must mention both this miner and the current generated-skill inventory
- shared bundles must include [dependencies.md](./references/dependencies.md)
