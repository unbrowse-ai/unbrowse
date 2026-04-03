---
name: first-principles-skill-design
description: Redesign a skill from first principles. Use when creating a new skill, compressing a bloated one, or deciding what belongs in `SKILL.md` versus `references/` and `scripts/`.
---

# First-Principles Skill Design

Core job:

- turn a vague or bloated skill into a narrow, high-trigger-accuracy contract

Use this skill when:

- creating a new skill
- redesigning a weak or oversized skill
- deciding what should live in `SKILL.md`, `references/`, or `scripts/`
- checking why a skill under-triggers, over-triggers, or behaves inconsistently

Do not use this skill for:

- minor copy polish on an already-good skill
- performing the domain work the target skill is supposed to do
- adding explanation or examples without changing behavior

Workflow:

1. Start from the user outcome, not the existing prose.
2. Define the skill's single core job, positive triggers, and explicit non-triggers.
3. Strip the workflow down to the shortest path that still works.
4. Move durable detail to `references/` and deterministic repeated work to `scripts/`.
5. Add only the load-bearing rules that prevent real failure modes.
6. Validate against obvious matches, paraphrased matches, and adjacent wrong requests.

Load-bearing rules:

- the description must carry both `what it does` and `when to use it`
- one skill, one core job
- trigger logic belongs in the header, not hidden in body prose
- constraints beat explanation
- if a detail is not always needed, move it out of `SKILL.md`
- if a script removes ambiguity, prefer the script over prose
- if you cannot name the non-triggers, the skill is not finished

Resources:

- put long-lived truth tables, templates, or policy detail in `references/`
- put repeated exact workflows in `scripts/`

Compression pass:

- remove anything that does not change behavior, prevent failure, or improve trigger accuracy
