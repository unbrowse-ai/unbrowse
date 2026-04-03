# Runtime Pointers

Keep concrete secrets and machine-local values out of `SKILL.md`.

## Required analytics surfaces

- backend joined summary: `GET /v1/analytics/campaigns`
- landing detail: `GET /v1/analytics/acquisition`
- variant rollup: `GET /v1/landing/summary`

## X-native capture requirements

- authenticated `x.com` session in the browser or via the Unbrowse login flow
- use Unbrowse on the exact analytics page the operator cares about
- preserve `campaign_id` and `content_id` from the incoming request when replaying

## Relevant env / runtime inputs

- `UNBROWSE_BACKEND_URL`
- `UNBROWSE_API_KEY`
- `UNBROWSE_ATTRIBUTION_B64`

## Id contract

Preferred mapping:

- `channel`: `x`, `google`, `meta`, `linkedin`, `tiktok`, `email`, `reddit`, `hackernews`
- `campaign_id`: stable acquisition family id
- `content_id`: exact post/article/ad/content unit id
- `creative_id`: creative variant id when ads or media differ
- `variant_id`: landing copy variant
- `experiment_id`: experiment bucket

## Safety rules

- do not write cookies, auth headers, bearer tokens, or local credential paths into bundle artifacts
- do not change canonical ids after launch unless you also rewrite the join logic
- prefer route replay over browser-only analytics checks once a stable X route is learned
