---
name: gh-paper-delivery
description: Turn whitepapers, PRDs, repo context, and launch goals into a managed GitHub delivery system. Use when the user wants GitHub issues, epics, blockers, priorities, a private Project board, Kanban/Roadmap views, paper references, and dated sprints based on contributor velocity.
---

# GH Paper Delivery

Use this when the job is not just "write issues", but "turn paper/spec context into an executable GitHub plan."

Default target:
- backlog in the delivery repo
- explicit epics + child issues
- `priority:p0/p1/...`
- blocking links
- private GitHub Project
- minimal views: table, kanban, roadmap
- fields: `Track`, `Paper`, `Sprint`, `Start Date`, `Target Date`
- dates based on real contributor velocity, then verified

## Workflow

1. Read the source context first.
   - repo docs
   - referenced PDFs / whitepapers
   - Overleaf links
   - existing GitHub issues / project state
2. Audit before creating.
   - find existing issues
   - reuse, update, reprioritize, or split before opening new ones
   - separate already-solved bugs from open defects
3. Convert context into execution slices.
   - epics for release lanes
   - narrow implementation issues
   - separate phase 1 vs later-phase research
   - split "whitepaper must ship" from "traction" and "post-release"
4. Make each issue implementation-ready.
   - scope
   - acceptance criteria
   - test / verification expectations
   - dependency notes
   - `## Paper References` when tied to a paper
5. Wire priorities and blockers.
   - use `p0` only for real shipment blockers
   - link dependencies so the board reflects execution order
   - prefer explicit blocker trees over vague labels
6. Build the project board.
   - private by default
   - keep only the default table plus one Kanban and one Roadmap view
   - create custom fields only if they carry planning signal
7. Add roadmap dates.
   - use contributor velocity as an upper bound, not a promise
   - date epics first
   - then date blockers and dependent work
   - overlap only when the dependency graph allows it
8. Verify.
   - query the project back
   - confirm views, fields, privacy, sample items, and date values

## Default Taxonomy

Use these defaults unless the user asks for a different structure.

`Track`
- `Whitepaper Release`
- `Traction`
- `Router`
- `Payments`
- `Trust & Security`
- `Solutions & Onboarding`
- `Bugfixes`
- `Post-Release`

`Paper`
- `Main Whitepaper`
- `Router / Machine Intent`
- `Token Utility`
- `None`

`Sprint`
- `Whitepaper Release`
- `Traction Push`
- `Post-Whitepaper`
- `Research / Future`

## Issue Rules

- Add `## Paper References` for paper-bound issues. Include the canonical Overleaf link and any local PDF the user explicitly named.
- Split phase-1 shippable work from future-state ambitions. Do not let a release issue absorb the full research roadmap.
- If a repo audit finds real open defects, create bug issues and raise them above speculative feature work.
- Keep issue titles action-shaped: `feat(...)`, `bug(...)`, `launch(...)`, `release(...)`, `research(...)`, `docs(...)`.
- If GitHub Project clutter gets out of hand and the API cannot delete views cleanly, prefer rebuilding one clean private board over leaving junk behind.

## Date Model

- Use recent public GitHub signals for the expected owner:
  - commit contributions
  - PR contributions
  - issue contributions
  - repo-specific commit history in the most relevant repos
- Treat that pace as a planning ceiling.
- Keep near-term blockers tight.
- Push research tails later so the roadmap stays credible.
- After stamping dates, verify a sample of epic + blocker items with GraphQL.

## Guardrails

- Do not assume Project visibility should be public. Private unless the user says otherwise.
- Do not create extra views "because maybe useful." Minimal board.
- Do not duplicate issues that already capture the work.
- Do not date everything off vibes. Pull actual GitHub velocity first.
- If the token lacks `project` scope, stop and ask the user to authorize before mutating the board.

## Read When

- Read [references/github-project-ops.md](./references/github-project-ops.md) when you need the exact `gh api graphql` patterns for project inspection, velocity checks, item lookup, or date stamping.
