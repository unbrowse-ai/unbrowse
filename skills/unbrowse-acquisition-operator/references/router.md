# Acquisition Router

Use this file to keep the entry skill small. Read only the sections you need.

## Default ICP buckets

### `agent-builder`

- signals:
  - `utm_term` or referrer mentions `playwright`, `puppeteer`, `browser-use`, `agent`, `automation`
- struggling moment:
  - browser flow works in demo, breaks in prod
- landing angle:
  - stop making agents click buttons to do API work
- success signal:
  - install copy
  - first successful task

### `openclaw-normie`

- signals:
  - `openclaw`, `plugin`, `personal agent`, `faster web tasks`
- struggling moment:
  - my agent is slow on websites
- landing angle:
  - install one plugin, skip browser waiting
- success signal:
  - install copy
  - plugin install

### `mcp-host`

- signals:
  - `mcp`, `claude code`, `cursor`, `tool calling`, `server`
- struggling moment:
  - too much glue to make website actions available in hosts
- landing angle:
  - one website action layer for MCP hosts
- success signal:
  - install copy
  - MCP setup completion

## Funnel stack

Use this exact stack unless the user explicitly wants a different view.

### Diagnostic pre-funnel

- `attention -> landing`
- `landing -> icp-path-click`
- `icp-path-click -> install-copy`
- `install-copy -> install/setup complete`

### Canonical product funnel

- `registered -> activated -> aha -> repeat -> retained_d7 -> retained_d30`

### Compounding / expansion layer

- `publish/reuse`
- `team adoption`
- `paid`
- `referral`

## Skill router

### Diagnose the leak

- [`internal-analytics`](/Users/lekt9/.codex/worktrees/81eb/unbrowse/skills/internal-analytics/SKILL.md)
- [`unbrowse-funnel-operator`](/Users/lekt9/.codex/skills/unbrowse-funnel-operator/SKILL.md)
- [`unbrowse-funnel-metrics`](/Users/lekt9/.agents/skills/unbrowse-funnel-metrics/SKILL.md)

### Lock the buyer + message

- [`positioning-messaging`](/Users/lekt9/.agents/skills/positioning-messaging/SKILL.md)
- [`keyword-research`](/Users/lekt9/.agents/skills/keyword-research/SKILL.md)
- [`unbrowse-ai`](/Users/lekt9/.claude/skills/unbrowse-ai/SKILL.md)

### Instrument assignment + measurement

- [`analytics-tracking`](/Users/lekt9/.claude/skills/analytics-tracking/SKILL.md)
- [`ab-test-setup`](/Users/lekt9/.claude/skills/ab-test-setup/SKILL.md)

### Research accounts / pages / competitors

- [`unbrowse`](/Users/lekt9/.agents/skills/unbrowse/SKILL.md)

Use Unbrowse for:
- X account pattern mining
- landing page claim capture
- ad library or public page research where accessible
- message-match checks between ad, post, and landing

### Execute distribution

- [`paid-ads`](/Users/lekt9/.claude/skills/paid-ads/SKILL.md)
- [`unbrowse-typefully-campaigns`](/Users/lekt9/.hermes/skills/marketing/unbrowse-typefully-campaigns/SKILL.md)
- [`unbrowse-growth-os`](/Users/lekt9/.hermes/skills/marketing/unbrowse-growth-os/SKILL.md)

## Vision lock

Use `unbrowse-ai` rules here:

- public framing defaults to the shared-route-graph wedge
- do not reveal the whole cathedral before the doorway
- keep one clear distinction between present truth and long-term upside
- do not let acquisition copy drift into generic AI SaaS language

For acquisition, the safe default story is:

- the web already speaks JSON
- Unbrowse helps agents stop repeating browser work
- faster, cheaper, more reliable than repeated browser automation

Only widen to network/control-point/toll-booth framing when:

- the ask is internal strategy
- the ask is investor framing
- or the user explicitly wants the long-term moat story

## Boundary with Growth OS

Use `unbrowse-acquisition-operator` when the question is:

- which leak to fix
- which ICP to target
- which variant to assign
- how to match ad/post/landing

Hand off to `unbrowse-growth-os` when the question is:

- broad launch sequencing
- channel mix across Reddit, HN, X, email, TG, PH, OpenClaw
- 100x traction loops
- ongoing GTM execution across multiple channels

The rule:

- acquisition operator picks the leak and experiment
- growth OS executes the broader channel machine around it

## Decision rules

- weak `traffic -> icp-path-click`: wrong audience or weak first message
- weak `icp-path-click -> install-copy`: landing mismatch
- weak `install-copy -> activated`: setup / first-use problem, not top-of-funnel
- high scroll / section reach with low install intent: interesting copy, weak offer
- high install intent from one channel but not others: keep the message, fix targeting

## Minimal assignment schema

Capture:

- `utm_source`
- `utm_medium`
- `utm_campaign`
- `utm_content`
- `utm_term`
- `gclid`
- `wbraid`
- `gbraid`
- `fbclid`
- `referrer_host`
- `landing_variant`
- `icp`
- `experiment_id`

Persist:

- first-touch context
- sticky variant cookie
- optional inferred ICP bucket

## Compression rule

If the plan starts turning into:
- all-channel launch plan
- generic content calendar
- big rebrand exercise

cut it back to:
- one leak
- one ICP
- one assignment rule
- one experiment
