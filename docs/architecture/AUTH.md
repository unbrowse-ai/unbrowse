# Identity and authentication

Unbrowse separates three concerns:

- **Account identity:** email sign-in establishes the human or organisation.
- **Agent access:** `ubr_` API keys authenticate CLI and SDK requests.
- **Site sessions:** cookies and site credentials stay in the local runtime.

## Account flow

```bash
unbrowse register --email you@example.com
```

The CLI stores the returned key in `~/.unbrowse/config.json` with restrictive
permissions. SDK consumers can pass the key directly or use
`UNBROWSE_API_KEY`.

Keys can be listed, created, rotated, and revoked from `/account`. Plaintext is
shown only when a key is created or rotated.

## Site authentication

```bash
unbrowse auth https://example.com/login
```

The local browser completes the site's normal login flow. Session material is
kept locally and injected only into matching site requests. Marketplace route
metadata never contains cookies, passwords, bearer values, or form secrets.

## Failure behavior

- Missing or invalid account key: HTTP 401.
- Valid key without permission: HTTP 403.
- Site session expired: return `auth_required` with a concrete next step.
- Insufficient usage credits: HTTP 402 and the SDK's insufficient-credits error.
