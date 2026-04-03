# X Campaign Feedback Router

Keep the entry skill small. Read only what the current decision needs.

## Canonical ids

Always normalize to this set first:

- `channel`
- `campaign_id`
- `campaign_name`
- `content_id`
- `content_type`
- `creative_id`
- `variant_id`
- `experiment_id`
- `inferred_icp`

If these do not exist yet, define them before optimizing.

## Metric stack

Use this exact order unless the user explicitly wants a different view.

### Distribution plane

- `impressions`
- `link_clicks`
- `profile_clicks`
- `likes`
- `reposts`
- `replies`
- `bookmarks`
- optional `spend`

### Product plane

- `landing_sessions`
- `content_page_sessions`
- `install_section_views`
- `install_command_copies`
- `reported_installs`
- `setup_completed`
- `cli_invoked`
- `registrations`
- `first_resolve_started`
- `first_resolve_succeeded`
- `successful_sessions`

## Read order

### Joined backend truth

- `/v1/analytics/campaigns`
- `/v1/analytics/acquisition`
- `/v1/landing/summary`

Use these first. They tell you whether the leak is on the product side before you spend time on X capture.

### X-native truth

Use [`unbrowse`](/Users/lekt9/.agents/skills/unbrowse/SKILL.md) for:

- authenticated X post analytics
- X ads/campaign manager pages
- X account/profile analytics when needed
- learning the replayable metric routes behind those pages

### Experiment / funnel truth

- [`unbrowse-acquisition-operator`](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/unbrowse-acquisition-operator/SKILL.md)
- [`internal-analytics`](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/internal-analytics/SKILL.md)

### Distribution execution

- [`unbrowse-typefully-campaigns`](/Users/lekt9/.hermes/skills/marketing/unbrowse-typefully-campaigns/SKILL.md)
- [`paid-ads`](/Users/lekt9/.claude/skills/paid-ads/SKILL.md)

## Decision rules

- high `impressions`, low `link_clicks`: hook/creative problem
- high `link_clicks`, low `landing_sessions`: broken link or attribution mismatch
- high `landing_sessions`, low `install_command_copies`: landing promise mismatch
- high `install_command_copies`, low `reported_installs`: installer/setup friction
- high `reported_installs`, low `first_resolve_succeeded`: onboarding / first-task problem
- high X engagement, low product outcomes: entertaining content, weak buyer match
- low X engagement, high product conversion on the few clicks: keep landing, rewrite distribution

## Canonical operator loop

1. pick one entity set
2. read backend joined truth
3. capture missing X-native metrics with Unbrowse
4. normalize into canonical ids
5. name one leaking transition
6. ship one content/landing/ad change

## Narrow surface rule

Do not start with:

- full social dashboard
- all-channel reporting
- broad BI rebuild

Start with:

- one X post or one ad set
- one landing variant family
- one downstream success metric
