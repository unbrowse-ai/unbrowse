# Runtime Pointers

Keep secrets and machine-local values out of `SKILL.md`.

## Primary analytics surfaces

- `GET /v1/analytics/campaigns`
- `GET /v1/analytics/acquisition`
- `GET /v1/analytics/install`
- `GET /v1/analytics/install-funnel`
- `GET /v1/analytics/funnel`
- `GET /v1/analytics/dashboard`
- `GET /v1/landing/summary`

## Relevant runtime inputs

- `UNBROWSE_BACKEND_URL`
- `UNBROWSE_API_KEY`
- `UNBROWSE_ATTRIBUTION_B64`

## Canonical ids

- `channel`
- `campaign_id`
- `content_id`
- `variant_id`
- `experiment_id`
- `inferred_icp`
- `install_id`
- `session_id`

## Rule

- keep the ids stable across distribution, landing, install, and activation
- if a stage cannot be joined to these ids, treat it as instrumentation debt first

## Visual surface

- `visualizers/funnel-merjs`
- run: `cd /Users/lekt9/.codex/worktrees/81eb/unbrowse/visualizers/funnel-merjs && zig build serve`
- desktop: `cd /Users/lekt9/.codex/worktrees/81eb/unbrowse/visualizers/funnel-merjs && zig build desktop && open zig-out/UnbrowseVisualLab.app`
- local snapshot route: `GET /api/snapshot`
- create viz session from arbitrary JSON: `POST /api/viz`
- fetch saved viz session envelope: `GET /api/viz?id=...`
- render saved session: `GET /viz?id=...`
- json-render lab: `GET /json-render`
- purpose: one merjs screen for the whole funnel, plus an arbitrary-json visualization lab for prompt + payload experiments
- operator contract: `analytics payload -> POST /api/viz -> open /viz?id=...`
- snapshot shortcut payload:
  - `source=analytics_snapshot`
  - `kind=analytics_snapshot`
  - `prompt=<question>`
  - `days=<window>`
  - `view_hints=["funnel","campaigns","icp"]`
- lab inputs: paste JSON, drop `.json`, reopen a copied hash-state URL, or push saved session ids
