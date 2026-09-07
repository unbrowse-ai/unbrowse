# Test specifications

Every release needs two corroborations: automated contract tests and a runnable
end-to-end path.

## SDK

- Typecheck both the bundled `unbrowse/sdk` surface and compatibility packages.
- Assert API-key headers, retry policy, idempotency, credits response shape, and
  `InsufficientCreditsError` mapping.

## CLI

- Run health, resolve-without-execute, one cache hit, and one browser fallback.
- Confirm a failed route remains a failure with an actionable `next_step`.

## Frontend

- Production build succeeds.
- Account, billing, docs, login, and search render at mobile and desktop widths.
- Keyboard focus, labels, loading states, and error states remain visible.

## Privacy

- Sanitization fixtures cover cookies, auth headers, request bodies, query
  secrets, and storage-derived values.
- A publish test proves those values are absent from the resulting contract.
