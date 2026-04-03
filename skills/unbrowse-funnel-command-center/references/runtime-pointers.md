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
