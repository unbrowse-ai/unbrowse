# System overview

Unbrowse has four cooperating surfaces:

1. The CLI and local runtime accept an intent, execute known routes, and control
   Chrome when browsing is required.
2. The route service stores sanitized contracts, ranks candidates, and tracks
   freshness and provenance.
3. The TypeScript SDK exposes the same resolve/execute/account contract to apps.
4. The frontend handles documentation, email sign-in, API keys, and credits.

## Request lifecycle

```text
intent + optional URL
        │
        ▼
local cache → shared route lookup → ranked candidate
        │                         │
      hit                       miss/stale
        │                         │
        ▼                         ▼
direct replay             browser capture
        │                         │
        └──────── result + trace ─┘
```

A captured route is not published automatically with user data. The local
runtime removes secrets and values, preserves only the reusable request shape,
and publishes only at an explicit checkpoint.

## Accounts and credits

Email sign-in creates an account. API keys authenticate agents and applications.
Metered work deducts credits from the account ledger. Promotional, purchased,
and earned credits share one balance; earned credits can be redeemed later when
redemption becomes available.

No client-side payment protocol is part of the current product contract.
