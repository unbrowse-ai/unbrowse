---
name: unbrowse-acquisition-operator
description: Tighten Unbrowse acquisition from traffic source to activation. Use when Lewis asks which ICP to target, how to bucket traffic, what landing/ad/content variants to test, how to use UTMs/cookies/sticky assignment, or how to stop top-of-funnel leakage before activation.
user-invocable: true
---

# Unbrowse Acquisition Operator

Core job:

- turn a fuzzy growth idea into one measurable acquisition loop with one leak to fix

Use this skill when:

- Lewis asks how to tighten the funnel
- the question is `which ICP should see what message`
- the question is `how should traffic be bucketed or assigned`
- landing variants, UTMs, cookies, sticky assignment, or top-of-funnel leakage are in play
- paid + organic + landing need to match for one ICP
- X account research, lookalike research, or ad/creative routing should feed the same landing experiment

Do not use this skill for:

- pure retention or post-activation work with no acquisition question
- one-off tweet writing, ad copy writing, or landing polish by itself
- raw analytics instrumentation with no funnel decision
- broad GTM brainstorming with no stage transition to improve
- backend-only analytics/code changes with no operator decision to make

Workflow:

1. Pull current truth first. Do not start with creative.
   - use `internal-analytics`
   - use `unbrowse-funnel-operator` when the leak is unclear
2. Name one leaking transition only.
   - examples: `traffic -> icp-path-click`, `landing -> install-copy`, `install-copy -> activated`
3. Lock one ICP/bucket only.
   - examples: `agent-builder`, `openclaw-normie`, `mcp-host`
4. Define assignment signals.
   - UTM params
   - click ids
   - referrer
   - query terms
   - sticky cookie
5. Pick one experiment.
   - one message angle
   - one landing variant pool
   - one creative family
   - one acquisition channel
   - one primary success metric
6. Route subwork to the right skill.
   - positioning -> `positioning-messaging`
   - category/search language -> `keyword-research`
   - Unbrowse framing / disclosure -> `unbrowse-ai`
   - measurement/schema -> `analytics-tracking`
   - experiment design -> `ab-test-setup`
   - paid media / X ads / audience structure -> `paid-ads`
   - X account, ad, and landing research -> `unbrowse`
   - organic X campaign alignment -> `unbrowse-typefully-campaigns`
   - broad launch / multi-channel GTM execution -> `unbrowse-growth-os`
7. Output the operating plan.
   - bottleneck
   - ICP
   - assignment rule
   - variant plan
   - metrics
   - this-week actions

Load-bearing rules:

- one skill, one leak, one ICP, one primary metric
- do not widen ICPs to hide weak message fit
- do not randomize across unrelated audiences
- paid message, organic message, and landing promise must match
- assignment must be first-party: UTM, referrer, click id, query, on-site behavior
- sticky assignment beats per-refresh randomness
- optimize for activation signal, not CTR vanity
- if you cannot say what leakage stage you are fixing, stop and diagnose first
- if a channel cannot be measured to downstream activation, deprioritize it
- public acquisition should sell the real doorway, not the full cathedral
- lead with the Phase 1 wedge: faster, cheaper, more reliable route reuse for agents
- long-term moat language is allowed only when the ask is internal, investor-facing, or explicitly strategic
- acquisition experiments must strengthen the canonical product funnel, not just farm traffic

X / ads rule:

- use X as one acquisition path, not the entire strategy
- research 5-10 adjacent accounts first: hooks, replies, offers, landing promises, audience clues
- build audiences from concrete buyer pain, not generic `AI people`
- keep paid and organic creative in the same message family as the landing variant
- if direct account mutation is blocked, output exact campaign/audience/creative payloads instead of pretending execution happened

Default output:

- current leak
- ICP and why this bucket
- assignment logic
- control vs variant
- primary metric
- guardrails
- channel plan
- this-week ship list

Always read:

- [router](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/unbrowse-acquisition-operator/references/router.md)
