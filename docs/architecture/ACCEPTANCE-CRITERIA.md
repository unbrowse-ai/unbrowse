# Acceptance criteria

## Install and identity

- Setup installs the current Agent Skill and does not require financial setup.
- Account registration returns an API key once and stores it with restrictive
  permissions.
- Keys can be rotated and revoked.

## Resolution and execution

- A known fresh route can resolve and execute without opening Chrome.
- A miss returns a concrete next step or opens the browser when authorized.
- Retries of a state-changing execute use the same idempotency key.
- An insufficient balance fails with a typed credits error and never reports
  success.

## Privacy

- Published route data contains no cookies, passwords, auth headers, or captured
  user payloads.
- Authenticated site requests execute locally.
- Users can opt out of contribution without disabling local use.

## Frontend and docs

- CLI and SDK examples match version 11.1.1 and the flat command surface.
- Account and billing screens display live credits, loading, and failure states.
- Retired finance routes do not expose obsolete setup instructions.
