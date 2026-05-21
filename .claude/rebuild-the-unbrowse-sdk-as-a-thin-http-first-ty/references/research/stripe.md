# Stripe Node SDK — distilled shape

source_id: github.com/stripe/stripe-node
deepwiki: https://deepwiki.com/stripe/stripe-node
fetched: 2026-05-21

## Constructor
`new Stripe(apiKey: string, config?: { apiVersion?, maxNetworkRetries?, timeout?, telemetry? })`. Positional `apiKey`. Defaults: `maxNetworkRetries: 2`, `timeout: 80000ms`.

## Resource pattern
Top-level resources: `stripe.customers.create`, `stripe.charges.list`, `stripe.paymentIntents.confirm`. CRUD + listing per resource.

## Error hierarchy (StripeError base)
- `StripeCardError`, `StripeInvalidRequestError`, `StripeAPIError`
- `StripeAuthenticationError` (401), `StripePermissionError` (403)
- `StripeRateLimitError` (429)
- `StripeConnectionError`
- `StripeSignatureVerificationError` (webhook sig)
- `StripeIdempotencyError`

## Idempotency
- Automatic on retried requests.
- Per-request override: `{ headers: { 'Idempotency-Key': '...' } }`.
- `lastResponse.idempotencyKey` echoed on success.

## Retry
- `_shouldRetry` in `RequestSender`; honors `stripe-should-retry` header.
- Retries on: connection error, 409, 5xx.
- Exponential backoff with jitter.
- Per-request override: `{ settings: { maxNetworkRetries: 0 } }`.

## Takeaways for Unbrowse
- Adopt Stripe error-class naming style (`UnbrowseRateLimitError`).
- Adopt **Idempotency-Key** for `/v1/execute` so agents safely retry on network error.
- Per-request override for `maxRetries` + `timeout`.
- Flat top-level methods are fine for unbrowse; group only `account.*` and `keys.*`.
