---
name: unbrowse-funnel-command-center
description: Run the full Unbrowse funnel as one operating system from traffic source to activation, repeat use, retention, monetization, and expansion. Use when Lewis asks what the biggest leak is, what to tighten next, or how X, ads, content, landing, install, onboarding, retention, and paid all fit together.
user-invocable: true
---

# Unbrowse Funnel Command Center

Core job:

- turn a broad funnel question into one prioritized leak, one owner, and one next experiment

Use this skill when:

- Lewis asks about the whole funnel
- the question is `what should we tighten next`
- multiple stages are involved: X, ads, articles, landing, install, activation, retention, paid
- there is confusion about whether the leak is top-of-funnel, setup, onboarding, or retention
- several skills need to be coordinated without turning them into one blob

Do not use this skill for:

- one narrow landing or ad question by itself
- one-off copy edits
- pure analytics ingestion changes with no funnel decision
- generic GTM brainstorming with no measurable stage transition

Workflow:

1. Pull private funnel truth first.
   - use `internal-analytics`
   - use backend route truth, not public docs copy
2. Name the exact leaking transition.
   - `impressions -> clicks`
   - `clicks -> landing`
   - `landing -> install_copy`
   - `install_copy -> reported_install`
   - `reported_install -> first_resolve_succeeded`
   - `first_resolve_succeeded -> repeat`
   - `repeat -> retained_d7`
   - `retained_d7 -> retained_d30`
   - `retained -> paid`
   - `retained -> referral / team adoption`
3. Route to the specialist skill.
   - traffic / ICP / variants -> `unbrowse-acquisition-operator`
   - X / article / ad feedback loop -> `x-campaign-feedback-operator`
   - analytics read or contract truth -> `internal-analytics`
   - broad product-funnel diagnosis -> `unbrowse-funnel-operator`
   - landing page leak -> `page-cro`
   - signup / account creation leak -> `signup-flow-cro`
   - first-run / activation leak -> `onboarding-cro`
   - retention / habit loop -> `retention-engagement`
   - upgrade / monetization leak -> `paywall-upgrade-cro`
   - referral / ambassador / word-of-mouth -> `referral-program`
4. Keep the work narrow.
   - one leak
   - one owner skill
   - one primary metric
   - one experiment
5. Output the operator call.
   - current bottleneck
   - why this stage is next
   - specialist skill to call
   - exact metric to move
   - this-week ship list

Load-bearing rules:

- one entry skill owns the full-funnel question
- specialist skills keep stage logic separate
- do not merge acquisition, onboarding, retention, and monetization logic into one giant prompt
- optimize the earliest proven bottleneck first
- if top-of-funnel is healthy, stop changing hooks and fix product friction
- if activation is healthy but repeat is weak, stop changing onboarding and fix retention loops
- if retention is healthy but paid is weak, stop changing acquisition and fix monetization
- if the stage is unclear, diagnose first and do not guess

Default output:

- stage map
- biggest leak
- owner skill
- primary metric
- next experiment
- follow-on stage after that

Always read:

- [router](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/unbrowse-funnel-command-center/references/router.md)
- [runtime-pointers](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/unbrowse-funnel-command-center/references/runtime-pointers.md)
