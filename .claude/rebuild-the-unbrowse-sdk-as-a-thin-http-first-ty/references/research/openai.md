# OpenAI Node SDK — distilled shape

source_id: github.com/openai/openai-node
deepwiki: https://deepwiki.com/openai/openai-node
fetched: 2026-05-21

## Constructor
`new OpenAI({ apiKey?, baseURL?, timeout?, maxRetries?, fetch?, logLevel?, ... })`. Env fallbacks: `OPENAI_API_KEY`, `OPENAI_BASE_URL`. `maxRetries` default 2. `fetch` injectable; defaults `globalThis.fetch`.

## Error hierarchy
All inherit from `OpenAIError`:
- `APIError` (base for any API-returned error)
  - `RateLimitError` (429)
  - `AuthenticationError` (401)
  - `NotFoundError` (404)
  - `BadRequestError` (400)
  - `InternalServerError` (5xx)
- `APIConnectionError` (network)
  - `APIConnectionTimeoutError`

## Retry
- Exponential backoff with jitter.
- Retries on network errors, 5xx, 429 (honors `Retry-After`).

## Request ID + Debug logging
- Every response carries `_request_id` from `x-request-id` response header.
- `.withResponse()` exposes raw response.
- `logLevel` (or `OPENAI_LOG` env): `off | error | warn | info | debug`.

## Takeaways for Unbrowse
- This is the canonical agent-SDK pattern. **Adopt verbatim.**
- Object-form constructor (not positional) — extensible.
- Typed error hierarchy is the contract the calling agent relies on.
- Surface `_request_id` on every response.
- `UNBROWSE_LOG=debug` env costs nothing, saves dozens of agent round-trips.
