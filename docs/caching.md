# Route caching

Unbrowse caches route metadata by intent, URL context, and dependencies.

- Public route shapes may be reused across accounts after sanitization.
- Authenticated responses and site credentials remain local.
- Freshness failures, authentication changes, and dependency changes invalidate
  affected entries.
- Cache misses fall through to shared lookup and then browser capture.

The cache stores pointers and reusable request shapes rather than user response
bodies. This keeps replay fast without turning private browsing into shared data.
