# Security

Unbrowse separates account identity, local website credentials, shared route knowledge, and usage accounting.

## Security Boundaries

- **Account identity:** cloud requests use an Unbrowse API key. Keys can be created, rotated, and revoked from the account surface.
- **Website credentials:** cookies, headers, and tokens captured for a site remain in the local credential vault. Shared skills store references and requirements, not secret values.
- **Route knowledge:** learned endpoints, schemas, and replay instructions may be shared. Captured response bodies and credentials are filtered before publication.
- **Credits:** granted, earned, and consumed credits are server-side ledger entries associated with the authenticated account.

## Local Capture

Browser capture is explicit and local. Unbrowse copies only the request material required to learn and replay a route. Authenticated replay resolves secrets from the local vault at execution time.

Treat generated skills as code: inspect unfamiliar routes before running state-changing actions, keep the local runtime updated, and use separate browser profiles when stronger isolation is required.

## API Keys

- Never commit a key or place it in a shared skill.
- Prefer environment variables or the local Unbrowse configuration.
- Rotate a key after suspected exposure.
- Revoke keys that are no longer used.
- Scope deployment secrets to the service that needs them.

## Execution Safety

Unbrowse distinguishes read-only work from state-changing work. Applications should ask for user confirmation before irreversible actions, enforce request timeouts and size limits, and preserve the target site's authorization boundaries.

An insufficient-credit response is an accounting result, not an invitation to retry an action through a different identity.

## Reporting a Vulnerability

Do not open a public issue for an unpatched vulnerability. Follow the private reporting instructions in the repository security policy and include reproduction steps, affected versions, and impact when possible.
