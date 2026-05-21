# Resend Node SDK — distilled shape

source_id: github.com/resend/resend-node
deepwiki: https://deepwiki.com/resend/resend-node
fetched: 2026-05-21

## Constructor
`new Resend(apiKey?: string)` — positional arg; falls back to `RESEND_API_KEY` env. Throws if neither. Base URL: `RESEND_BASE_URL ?? "https://api.resend.com"`.

## Resource pattern (nested namespaces)
Top-level instance exposes: `apiKeys`, `audiences`, `batch`, `broadcasts`, `contacts`, `domains`, `emails`. Each class takes the `Resend` client as a dep.

## Errors
- Unified `{ data, error }` response object (NOT thrown).
- `ErrorResponse` has `{ name: RESEND_ERROR_CODE_KEY, message }`.

## Retry
- No built-in retry. Idempotency-Key header on POST so caller can retry safely.

## Fetch
- Direct `globalThis.fetch`. Tests mock with `jest-fetch-mock`.

## Takeaways for Unbrowse
- `{data, error}` is a viable alternative to throwing but increases agent friction (every call needs branch). We will throw, matching Stripe/OpenAI.
- Env fallback for both API key AND base URL is standard.
- Resource-namespace pattern (`unbrowse.keys.list()`) reads well even for small SDKs.
