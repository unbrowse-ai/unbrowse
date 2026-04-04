# Agent Memory

Deprecated. Durable agent memory now lives in [AGENTS.md](/Users/lekt9/.codex/worktrees/18ba/unbrowse/AGENTS.md).

- Long-running workflows: publish admitted roots plus DAG-linked readable/mutable steps as standalone callable endpoints, so later agents can resume or invoke a single step without replaying the whole flow.
- Exact-URL search resolves should reject cached/marketplace skills that do not expose the same explicit search binding (for example `?q=`); obvious misses should return quickly, not trigger browser/capture side effects.
- Resolve should also reject generic feed/timeline skills for messaging intents; if the cache has no real inbox/message route, return a miss instead of a fake LinkedIn feed hit.
- Resolve should be the single public primitive: fast cached-domain search plus execute on hit, with no browser side effects on misses. Capture/index/publish stay off the hot resolve path unless explicitly forced.
- Resolve should return the whole relevant DAG slice for the chosen intent, not just a flat shortlist, and safe GET dependents should be surfaced as prefetch hints/context for later steps.
- Packaged runtime health/version checks should read the installed package version from the nearest package root when available, and fall back to the embedded release manifest inside compiled binaries.
- Explicit browser `go` flows should treat Kuri startup aborts and temporary connect failures as recoverable browse-session errors, so login/messaging learns retry instead of failing during warmup.
- Browse mode should stay thin: `go` opens a fresh Kuri session unless the caller explicitly passes `session_id`, and read ops should not silently reset/recover or rebind onto replacement tabs.
- Unbrowse local/runtime uses the vendored Kuri binary under `packages/skill/vendor/kuri/...`; patching `submodules/kuri` alone is not enough for real-path verification unless the vendored binaries are rebuilt.
- `origin/lewis/experiments` is the sandbox branch; its Cloudflare deploy should stay isolated on workers.dev and use its own `EXPERIMENTS_API_URL` secret/var instead of sharing staging preview config.
- staging/experiments frontend deploys should use `wrangler deploy` after `opennextjs-cloudflare build`; the direct OpenNext deploy path tries to prefill R2 incremental cache and 403s under current CI credentials.
