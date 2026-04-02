# Analytics API

Track the fundraising dashboard from the Worker API.

## Read

- `GET /v1/analytics/growth`
  - daily new registered users
  - 7d vs prior-7d growth
  - npm install snapshots
  - GitHub star snapshots
- `GET /v1/analytics/engagement`
  - DAU / WAU / MAU
- `GET /v1/analytics/retention`
  - D1 / D3 / D7 / D14 / D30 cohorts
- `GET /v1/analytics/usage`
  - API calls per session
  - repeat usage rate
  - churn split by default-browser replacement telemetry
- `GET /v1/analytics/funnel`
  - canonical optimize-against funnel
  - `registered -> activated -> aha -> repeat -> retained_d7 -> retained_d30`
- `GET /v1/analytics/install-funnel`
  - legacy first-run install/setup funnel
  - install, registration, first resolve, abandonment, failure buckets
- `GET /v1/analytics/network`
  - indexed skills/endpoints
  - unique indexed domains
  - skill reuse vs fresh indexing
- `GET /v1/analytics/economics`
  - cost saved per action
  - speedup per action
  - revenue per route / discovery query
  - target-volume + break-even math
- `GET /v1/analytics/dashboard`
  - combined payload for dashboards

## Write

- `POST /v1/analytics/sessions`
  - authenticated agent/session summary
  - send `session_id`, `started_at`, `api_calls`
  - optional: `discovery_queries`, `cached_skill_calls`, `fresh_index_calls`, `browser_mode`, `trace_version`
- `POST /v1/analytics/adoption`
  - admin-only external snapshots
  - metrics: `npm_installs`, `github_stars`, `cli_installs`
- `GET /v1/analytics/pricing`
  - current revenue assumptions
- `POST /v1/analytics/pricing`
  - admin-only pricing updates

## Notes

- Search endpoints now record graph `search` fee events, so discovery-query volume is visible to the economics API.
- Session summaries are the source of truth for per-session usage and browser-replacement churn cuts.
- Agent registration remains the built-in proxy for daily new users unless a dedicated install feed is added later.
