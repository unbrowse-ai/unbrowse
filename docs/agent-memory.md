# Agent Memory

Deprecated. Durable agent memory now lives in [AGENTS.md](/Users/lekt9/.codex/worktrees/18ba/unbrowse/AGENTS.md).

- Long-running workflows: publish admitted roots plus DAG-linked readable/mutable steps as standalone callable endpoints, so later agents can resume or invoke a single step without replaying the whole flow.
- Exact-URL search resolves should reject cached/marketplace skills that do not expose the same explicit search binding (for example `?q=`); obvious misses should return quickly, not trigger browser/capture side effects.
- Resolve should also reject generic feed/timeline skills for messaging intents; if the cache has no real inbox/message route, return a miss instead of a fake LinkedIn feed hit.
- Resolve should be the single public primitive: fast cached-domain search plus execute on hit, with no browser side effects on misses. Capture/index/publish stay off the hot resolve path unless explicitly forced.
- Resolve should return the whole relevant DAG slice for the chosen intent, not just a flat shortlist, and safe GET dependents should be surfaced as prefetch hints/context for later steps.
- Packaged runtime health/version checks should read the installed package version from the nearest package root when available, and fall back to the embedded release manifest inside compiled binaries.
