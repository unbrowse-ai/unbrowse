# Analytics API

Canonical product funnel:

`registered -> activated -> aha -> repeat -> retained_d7 -> retained_d30`

Use the direct endpoints for investor/product reads. Use `dashboard` only as an aggregate convenience surface.

## Read endpoints

- `GET /v1/analytics/growth`
- `GET /v1/analytics/usage`
- `GET /v1/analytics/funnel`
- `GET /v1/analytics/network`
- `GET /v1/analytics/economics`
- `GET /v1/analytics/dashboard`
- `GET /v1/analytics/activation`
- `GET /v1/analytics/engagement`
- `GET /v1/analytics/retention`
- `GET /v1/analytics/agents`
- `GET /v1/analytics/pricing`
- `GET /v1/analytics/bottleneck`
- `GET /v1/analytics/acquisition`
- `GET /v1/analytics/install`
- `GET /v1/analytics/install-funnel`

## Write endpoints

- `POST /v1/analytics/sessions`
- `POST /v1/analytics/adoption` — admin only
- `POST /v1/analytics/pricing` — admin only

## Semantics

- `funnel` is the canonical product/investor funnel.
- `install` and `install-funnel` are setup diagnostics only.
- Recovered profiles are excluded from the canonical funnel and surfaced separately.
- Session summaries are the primary source for usage, aha, repeat, network, and economics.
- Segment usage by `trace_version` when comparing releases.
