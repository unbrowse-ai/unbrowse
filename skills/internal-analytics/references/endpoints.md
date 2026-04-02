# Internal Analytics Endpoints

Source of truth:

- [backend/src/routes/analytics.ts](/Users/lekt9/.codex/worktrees/45e9/unbrowse/backend/src/routes/analytics.ts)

Read endpoints:

- `GET /v1/analytics/engagement`
- `GET /v1/analytics/retention?days=30`
- `GET /v1/analytics/activation`
- `GET /v1/analytics/growth?days=30`
- `GET /v1/analytics/usage`
- `GET /v1/analytics/funnel?days=30`
- `GET /v1/analytics/network`
- `GET /v1/analytics/economics`
- `GET /v1/analytics/agents`
- `GET /v1/analytics/bottleneck`
- `GET /v1/analytics/pricing`
- `GET /v1/analytics/dashboard`
- `GET /v1/analytics/acquisition?days=30`
- `GET /v1/analytics/install?days=90`
- `GET /v1/analytics/install-funnel?days=90`

Write endpoints:

- `POST /v1/analytics/sessions`
- `POST /v1/analytics/adoption` admin only
- `POST /v1/analytics/pricing` admin only

Rules:

- Treat all of these as internal-only.
- Do not reintroduce public docs for this surface.
- When checking exposure, verify auth and response headers together.
- Preferred read path: bundled fetch script.
