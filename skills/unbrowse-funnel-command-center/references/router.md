# Funnel Router

Keep the entry skill small. Use this file to decide which specialist owns the current leak.

## Canonical funnel stack

### Distribution

- `impressions`
- `link_clicks`
- `landing_sessions`

### Acquisition / install

- `landing_sessions`
- `icp_path_clicked`
- `install_command_copied`
- `reported_installs`
- `setup_completed`

### Activation

- `cli_invoked`
- `registrations`
- `first_resolve_started`
- `first_resolve_succeeded`

### Retention

- `repeat`
- `retained_d7`
- `retained_d30`

### Expansion

- `paid`
- `team_adoption`
- `referral`
- `publish_reuse`

## Route by leak

### Traffic / message / variant

Call [`unbrowse-acquisition-operator`](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/unbrowse-acquisition-operator/SKILL.md) when the leak is:

- `impressions -> clicks`
- `clicks -> landing`
- `landing -> install_command_copied`
- ICP mismatch
- landing variant assignment

### X / article / ad alignment

Call [`x-campaign-feedback-operator`](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/x-campaign-feedback-operator/SKILL.md) when the leak is:

- X post vs article vs ad mismatch
- weak X-native engagement or clickthrough
- missing join between content ids and downstream funnel outcomes

### Private truth / contract check

Call [`internal-analytics`](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/internal-analytics/SKILL.md) when the job is:

- read current metrics
- confirm route truth
- inspect analytics ingestion / auth / contract

### Product-funnel diagnosis

Call [`unbrowse-funnel-operator`](/Users/lekt9/.codex/skills/unbrowse-funnel-operator/SKILL.md) when:

- the bottleneck is unclear
- activation, repeat, retention, monetization, or network effects are mixed together

### Landing CRO

Call [`page-cro`](/Users/lekt9/.claude/skills/page-cro/SKILL.md) when:

- the landing page underperforms after traffic quality is already acceptable

### Signup / registration

Call [`signup-flow-cro`](/Users/lekt9/.claude/skills/signup-flow-cro/SKILL.md) when:

- `reported_installs -> registrations` is weak

### Onboarding / activation

Call [`onboarding-cro`](/Users/lekt9/.claude/skills/onboarding-cro/SKILL.md) when:

- `registrations -> first_resolve_succeeded` is weak

### Retention

Call [`retention-engagement`](/Users/lekt9/.agents/skills/retention-engagement/SKILL.md) when:

- `first_resolve_succeeded -> repeat`
- `repeat -> retained_d7`
- `retained_d7 -> retained_d30`

### Monetization

Call [`paywall-upgrade-cro`](/Users/lekt9/.claude/skills/paywall-upgrade-cro/SKILL.md) when:

- retention exists but paid conversion is weak

### Referral / loops

Call [`referral-program`](/Users/lekt9/.claude/skills/referral-program/SKILL.md) when:

- word-of-mouth, affiliate, ambassador, or team-spread is the next lever

## Decision rules

- weak `impressions -> clicks`: fix hook, audience, creative
- weak `clicks -> landing`: fix message match or link routing
- weak `landing -> install_copy`: fix landing promise and CTA
- weak `install_copy -> reported_install`: fix installer/setup path
- weak `reported_install -> first_success`: fix onboarding / first task
- weak `first_success -> repeat`: fix retention / use-case depth
- healthy retention, weak paid: fix monetization
- healthy paid, weak referral/team spread: fix expansion loops

## Bundling rule

The full funnel belongs in one bundle, not one giant skill.

- entry skill: `unbrowse-funnel-command-center`
- local subskills:
  - `internal-analytics`
  - `unbrowse-acquisition-operator`
  - `x-campaign-feedback-operator`
- external specialist skills stay referenced, not copied, unless they become repo-local later
