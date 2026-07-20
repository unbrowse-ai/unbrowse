# Frontend

The frontend is a Next.js 16 application deployed through OpenNext on
Cloudflare. It serves the marketing site, documentation entrypoints, email
sign-in, account settings, API keys, and credit balances.

## Primary routes

| Route | Purpose |
|---|---|
| `/` | Product explanation and install path |
| `/docs` | Current CLI and SDK quickstart |
| `/search` | Public route discovery |
| `/login` | Email sign-in and local CLI pairing |
| `/account` | Profile, API keys, and credit summary |
| `/billing` | Detailed credit ledger |

Retired finance-specific URLs redirect to `/billing` or `/account` so old links
do not strand users in obsolete setup flows.

## Design system

The site uses a neutral surface scale, one orange accent, characterful display
type, compact monospace data, visible focus states, and responsive layouts.
Account views use live backend values and explicit loading/error/empty states.

## Authentication

The primary flow is email magic-link authentication. Privy remains an optional
email/Google identity provider; embedded account finance features are disabled.
