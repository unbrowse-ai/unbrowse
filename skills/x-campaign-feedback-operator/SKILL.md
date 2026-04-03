---
name: x-campaign-feedback-operator
description: Close the feedback loop between X-native metrics, Unbrowse landing variants, articles, ads, installs, and first-success. Use when Lewis asks which X post, article, ad, campaign, ICP, or landing variant is actually winning and what to change next.
user-invocable: true
---

# X Campaign Feedback Operator

Core job:

- turn scattered X, article, ad, landing, install, and activation signals into one operating loop

Use this skill when:

- Lewis asks which X post actually worked
- X campaigns, articles, ads, and landing variants must align
- the question is `what resonated best`
- the question is `which content should we scale or kill`
- X-native metrics need to be joined to `campaign_id`, `content_id`, `variant_id`, or `experiment_id`
- Unbrowse should be used to learn the X analytics surface instead of hand-scraping

Do not use this skill for:

- generic tweet writing with no measurement question
- broad GTM planning with no X/content/ad feedback loop
- pure landing-page CRO with no external channel join
- generic analytics instrumentation with no operator decision
- one-off browser debugging on X with no campaign/metric outcome

Workflow:

1. Pull joined truth first.
   - use the backend campaign summary at `/v1/analytics/campaigns`
   - use `/v1/analytics/acquisition` when the landing side is unclear
   - use `/v1/landing/summary` when the variant pool is unclear
2. Lock one canonical entity set.
   - `channel`
   - `campaign_id`
   - `content_id`
   - optional `variant_id`
   - optional `experiment_id`
3. Separate the loop into two planes.
   - distribution plane: X-native metrics, ad metrics, article reads
   - product plane: landing, install, setup, first success
4. Use Unbrowse for X-native surface capture.
   - resolve authenticated X analytics pages
   - capture replayable routes
   - normalize returned fields into the canonical metric schema
5. Join by the canonical ids only.
   - never join on vague title text when ids exist
   - keep `campaign_id` and `content_id` stable across copy variants
6. Diagnose one leak only.
   - `impressions -> link_clicks`
   - `link_clicks -> landing`
   - `landing -> install_copy`
   - `install_copy -> install/setup`
   - `install/setup -> first_resolve_succeeded`
7. Output the operator decision.
   - keep, cut, rewrite, or retarget
   - next experiment
   - exact content or landing family to clone

Load-bearing rules:

- one canonical id scheme beats fuzzy attribution
- X-native metrics are evidence, not victory
- optimize to `first_resolve_succeeded`, not vanity engagement
- do not compare unrelated ICPs in one pool
- if content wins on X but dies on landing, fix landing not distribution
- if landing wins but X clickthrough is weak, fix hook/creative not product
- if ids are missing, stop and define the id contract before scaling spend
- use Unbrowse to learn real X routes; do not freeze brittle browser-only steps into the skill contract

Default output:

- winning entity set
- leaking transition
- evidence table
- keep / cut / rewrite call
- next experiment
- exact ids to preserve

Always read:

- [router](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/x-campaign-feedback-operator/references/router.md)
- [runtime-pointers](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/x-campaign-feedback-operator/references/runtime-pointers.md)
