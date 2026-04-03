---
name: skill-surface-ship
description: >-
  Maintain the repo's shipped skill surface end-to-end: skill docs, install path, sync flow, and publish path. Use when Lewis asks to update skill specs, `npx skills add`, package sync, or skill publishing.
user-invocable: true
generated-by: history-skill-miner
design-source: ./references/first-principles-skill-design.md
---

# Skill Surface Ship

Core job:

- change the shipped skill surface without letting docs, package, and publish paths drift apart

Use this skill when:

- editing root `SKILL.md`, `packages/skill`, skill-install docs, or skill-publish flow
- debugging `npx skills add`, skills discovery, or standalone skill repo sync
- tightening the public install and publish path for the shipped skill

Do not use this skill for:

- mining website APIs into runtime skills
- chat-history workflow mining itself; use the history miner for that
- product eval work that does not touch the skill surface

Workflow:

1. Start from `SKILL.md`, `packages/skill/SKILL.md`, `packages/skill/README.md`, and `scripts/sync-skill.sh`.
2. If CLI flags or command docs changed, run `bun scripts/sync-skill-md.ts`.
3. If install or publish behavior changed, run `bun run check:skill-docs` and a package smoke check such as `bun run pack:cli`.
4. If standalone repo sync matters, use `bash scripts/sync-skill.sh` rather than ad-hoc copies.
5. Keep the install command, docs, and shipped package behavior aligned before handoff.

Load-bearing constraints:

- keep one clear public install story
- treat the root skill doc as the public contract unless the repo says otherwise
- sync monorepo docs and packaged-skill docs together
