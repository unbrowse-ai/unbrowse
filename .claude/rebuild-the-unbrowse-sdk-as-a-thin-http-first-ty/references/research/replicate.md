# Replicate JavaScript SDK — distilled shape

source_id: github.com/replicate/replicate-javascript
deepwiki: https://deepwiki.com/replicate/replicate-javascript
fetched: 2026-05-21

## Constructor
`new Replicate({ auth?, userAgent?, baseUrl?, fetch?, fileEncodingStrategy?, useFileOutput? })`. `auth` falls back to `REPLICATE_API_TOKEN`. Header: `Authorization: Token <auth>`.

## Errors
- `ApiError` carries `message`, `request: Request`, `response: Response`.
- Tests assert `error.response.status` and `error.message`.

## Async predictions / polling
- `replicate.run(...)` for long-running predictions.
- `replicate.wait` polls `predictions.get(id)` at fixed interval until terminal state.

## Compatibility
- Node 18+ OR browsers. Cloudflare Workers, Vercel Edge, AWS Lambda. CI has separate `integration-node` and `integration-browser` jobs.

## Takeaways for Unbrowse
- `resolve` can have async-shaped surface (live capture takes seconds).
- Borrow `wait` pattern for future async routes (`unbrowse.captures.wait(captureId)`).
- Edge-runtime support is table stakes; verify in CI (node + browser + workerd lanes).
- Carry `Request` and `Response` on errors so debugging is local.
