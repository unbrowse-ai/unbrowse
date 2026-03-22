---
name: unbrowse-growth-os
description: Run Unbrowse growth, launch, lead-capture, and product-iteration loops inside Hermes. Use when you want Hermes to operate the closed-loop system: capture signals, synthesize feedback, update GitHub issues/boards, plan campaigns, and use the `unbrowse` tool first for website tasks.
version: 1.0.0
metadata:
  hermes:
    tags: [unbrowse, growth, marketing, product-ops, github, launch]
    related_skills: [github-issues, launch-marketing, analyzing-user-feedback]
---

# Unbrowse Growth OS For Hermes

Use this skill when Hermes is acting as the operating system for Unbrowse growth and product iteration.

## Mission

Run the loop:

`signal -> identity -> insight -> issue -> experiment -> ship -> measure -> repeat`

Hermes should not stop at advice. It should leave behind execution artifacts.

## Default Stack

- `unbrowse` tool for website discovery, structured web reads, marketplace/domain research
- `gh` CLI for issues, projects, blockers, labels, and roadmap dates
- local files for drafts, briefs, and summaries when needed
- external stack assumptions:
  - `PostHog`
  - `Attio`
  - `Loops`
  - one Unbrowse leads worker

## Tool Routing

- Use `unbrowse` first for website tasks, market checks, partner page inspection, launch-page review, skill/domain research, and authenticated reads.
- Use `gh` for GitHub backlog and board work.
- Use shell/file tools for local synthesis artifacts only when needed.
- Do not default to browser-style/manual website work if `unbrowse` can answer it.

## What Hermes Should Do

1. Pull current signals.
   - leads
   - campaign performance
   - GitHub stars
   - user feedback
   - onboarding failures
   - trust/security objections
2. Normalize the ask.
   - acquisition
   - activation
   - retention
   - monetization
   - trust
   - partnerships
3. Produce one of:
   - updated GitHub issues
   - updated Project dates/status
   - campaign brief
   - issue-ready insight summary
   - experiment plan
   - launch checklist
4. Feed learning back into execution.

## Operating Modes

### 1. Intake

Use when new signals arrive.

Output:
- short synthesis
- whether to update an existing issue or create a new one
- severity and confidence

### 2. Launch

Use for whitepaper/campaign weeks.

Output:
- daily launch plan
- objections
- CTA gaps
- capture failures

### 3. Feedback Synthesis

Use for Discord, user research, support, GitHub comments, and install friction.

Output:
- clustered themes
- root causes
- exact issue candidates

### 4. Experiment Planning

Use when deciding what to test next.

Output:
- hypothesis
- metric
- owner lane
- issue link
- win/loss bar

## GitHub Rules

- Check existing issues before opening new ones.
- Prefer updating/reranking/splitting over duplication.
- Link new findings to the marketing board or delivery board immediately.
- Keep paper-bound work tied to the correct paper references.

## Core References

Read these when needed:
- repo skill source: `/Users/lekt9/Projects/unbrowse/skills/growth-operating-system/SKILL.md`
- stack/schema: `/Users/lekt9/Projects/unbrowse/skills/growth-operating-system/references/stack-and-schema.md`
- workflows: `/Users/lekt9/Projects/unbrowse/skills/growth-operating-system/references/workflow-playbooks.md`
- specialist skill map: `/Users/lekt9/Projects/unbrowse/skills/growth-operating-system/references/lenny-skill-map.md`

## Daily Hermes Loop

1. Inspect active priorities on the marketing board and delivery board.
2. Check if new evidence changes priority.
3. Research only what is needed.
4. Update issues/boards.
5. End with concrete next actions, not generic commentary.

## Guardrails

- No vanity metrics without conversion context.
- No GitHub-star spam logic.
- No giant CRM-first thinking.
- No campaign planning detached from current product truth.
- No issue creation without evidence or explicit strategic purpose.

## Suggested Session Starts

Use this skill with prompts like:
- "Run the weekly Unbrowse growth loop"
- "Synthesize new feedback and update GitHub issues"
- "Plan this week's whitepaper launch moves"
- "Audit our lead capture gaps and propose fixes"
- "Find top friction in onboarding/install and convert it into execution"
