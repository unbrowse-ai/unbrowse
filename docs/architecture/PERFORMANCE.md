# Performance

Unbrowse improves repeat work by avoiding page rendering and DOM interpretation
when a fresh route is already known.

The execution order is:

1. in-process and local route cache
2. shared route lookup
3. direct request replay
4. browser capture or browser automation on miss

Cache entries include freshness and dependency metadata. Authentication changes,
failed replays, and site drift invalidate or demote affected routes.

The published 94-domain benchmark measured warmed cached routes against
Playwright and reported a 3.6× mean and 5.4× median speedup. Release claims must
remain tied to reproducible corpus runs; cache hits and browser fallbacks are
reported separately.
