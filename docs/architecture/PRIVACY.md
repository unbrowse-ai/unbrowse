# Privacy and data handling

Site credentials and authenticated browsing remain local.

## Stays on the local machine

- passwords, cookies, bearer values, and session storage
- authenticated response bodies
- browser profiles and screenshots
- raw capture traffic before sanitization

## May be shared after an explicit publish checkpoint

- host, method, and sanitized URL template
- parameter names, types, and safe enums
- human-readable route description
- provenance and freshness metadata

The publisher strips secret values and rejects suspicious payloads before any
route reaches the shared graph. Authenticated egress is never silently moved to
a server proxy that can read the credentials.

Users can disable contribution, remove local profiles, revoke API keys, and
delete synced account data from the corresponding settings surfaces.
