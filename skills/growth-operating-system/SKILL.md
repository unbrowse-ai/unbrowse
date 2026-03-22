---
name: growth-operating-system
description: Run Unbrowse as a closed-loop startup operating system: capture demand, unify leads and product signals, synthesize feedback, create/prioritize GitHub issues, plan experiments, ship, measure outcomes, and repeat. Use when the user wants a master workflow that connects PostHog, Attio, Loops, GitHub stars, whitepaper/launch campaigns, feedback, and issue tracking into one agent-driven loop.
---

# Growth Operating System

Use this when the job is not just marketing, analytics, or backlog management alone.

Default goal:
- one canonical lead + event model
- one intake path for product and growth signals
- evidence before opinions
- GitHub issues/projects as the execution layer
- PostHog/Attio/Loops as the system of measurement, memory, and lifecycle
- repeatable agent workflow from signal -> insight -> issue -> ship -> measure

## Startup First Principles

- Demand capture first. Anonymous traffic is wasted.
- Identity spine first. API key registration is the lowest-friction product identity.
- One event model. Do not let every tool invent its own schema.
- Evidence before roadmap. Issues should be backed by signals, not vibes.
- Tight loops beat big plans. Daily triage, weekly synthesis, monthly resets.
- Separate system of record from system of action.
  - `Attio`: people / companies / pipeline
  - `PostHog`: product analytics / attribution / cohorts / activation
  - `Loops`: outbound lifecycle and campaign email
  - `GitHub`: execution truth

## Core Stack

Ship this stack by default:
- `PostHog`
- `Attio`
- `Loops`
- one small Unbrowse leads worker / event router

Read [references/stack-and-schema.md](./references/stack-and-schema.md) when defining the canonical objects or ingestion paths.

## Master Workflow

1. Capture signals.
   - website events
   - API key registrations
   - whitepaper/download leads
   - demo / enterprise requests
   - chat asks
   - GitHub stars / repo interest
   - user interviews / Discord / support / bugs
2. Normalize them.
   - write to one canonical lead/event model
   - attach source, campaign, referrer, user segment, and confidence
3. Synthesize evidence.
   - cluster by pain, demand, conversion friction, trust concern, onboarding blocker, feature pull
   - separate noise from repeated patterns
4. Convert evidence into execution.
   - create/update GitHub issues
   - link to epics / blockers
   - stamp severity, owner lane, and experiment type
5. Plan experiments.
   - acquisition
   - activation
   - retention
   - monetization
   - trust / marketplace liquidity
6. Ship.
   - route work through the delivery board
   - keep marketing and product boards aligned, not merged
7. Measure.
   - did it improve conversion, activation, reuse, latency, revenue, or trust?
8. Feed the result back.
   - winning patterns become defaults
   - losing patterns get archived with explicit reasons

Read [references/workflow-playbooks.md](./references/workflow-playbooks.md) for the daily/weekly/monthly loop.

## Agent Roles

Use a master agent plus narrow specialist skills.

Master agent responsibilities:
- inspect current data sources and board state
- decide which loop is being run: intake, synthesis, planning, launch, postmortem
- call the minimum set of specialist skills
- produce artifacts that can be executed immediately

Specialist skills to compose:
- `launch-marketing`: launch narrative, calendar, channel plans
- `analyzing-user-feedback`: cluster feedback and extract root causes
- `content-strategy`: convert themes into campaigns and assets
- `partnership-bd`: partner/integration pipeline
- `writing-prds`: issue/brief/spec quality
- `prioritizing-roadmap`: force ranking
- `measuring-product-market-fit`: identify real pull vs vanity
- `founder-sales` / `enterprise-sales`: high-intent lead handling
- `marketplace-liquidity`: supply/demand thinking for the skill marketplace
- `gh-paper-delivery`: convert papers/specs into GitHub execution systems

Read [references/lenny-skill-map.md](./references/lenny-skill-map.md) when choosing which specialist skill to invoke.

## Execution Artifacts

Every run should leave behind at least one of:
- updated GitHub issue(s)
- updated Project field/date/status values
- campaign brief
- experiment brief
- insight summary with evidence
- lead segment definition
- postmortem / learning note

No run should end with only generic advice.

## Default Cadence

- Daily:
  - triage new leads, stars, feedback, broken onboarding, blocked installs
- Weekly:
  - synthesize patterns, rank top pains, update issues/boards, define experiments
- Launch weeks:
  - tighten to day-by-day message / distribution / conversion review
- Monthly:
  - reset narrative, prune stale issues, compare promised vs observed traction

## Issue Rules

- Product/growth issues must cite evidence source where possible.
- Use one issue for the system layer, separate issues for specific experiments.
- Do not let "collect data" become an unbounded swamp; define the decision it is meant to unlock.
- Separate `capture`, `synthesis`, `distribution`, `conversion`, and `transport` issues.

Read [references/issue-templates.md](./references/issue-templates.md) for the standard titles, fields, and acceptance criteria.

## Default Outputs By Trigger

If asked to "set this up":
- define stack
- define schemas
- define boards/issues
- define loop cadence
- identify missing product surfaces

If asked to "run the loop":
- inspect current signals
- summarize top learnings
- create/update issues
- rank next experiments

If asked to "plan campaigns":
- start from current product truths and available proof
- connect campaigns to measurable conversion points

If asked to "analyze feedback":
- cluster, quantify, rank, and map to execution or messaging changes

## Guardrails

- No giant CRM-first setup.
- No lead capture without consent and source attribution.
- No issue creation without checking existing issues first.
- No campaign work disconnected from product truth.
- No vanity metrics without conversion or activation context.
- GitHub stars are signal, not email consent.
- WebSocket/gRPC support is future-proofing, not a launch blocker.

## Read When

- Read [references/stack-and-schema.md](./references/stack-and-schema.md) when you need the canonical data model or SaaS boundaries.
- Read [references/workflow-playbooks.md](./references/workflow-playbooks.md) when you need the daily/weekly/monthly loop or board choreography.
- Read [references/lenny-skill-map.md](./references/lenny-skill-map.md) when you need to compose specialist product/growth skills around the master workflow.
- Read [references/issue-templates.md](./references/issue-templates.md) when opening or updating GitHub issues from insights.
