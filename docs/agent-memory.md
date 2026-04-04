# Agent Memory

Deprecated. Durable agent memory now lives in [AGENTS.md](/Users/lekt9/.codex/worktrees/18ba/unbrowse/AGENTS.md).

- Long-running workflows: publish admitted roots plus DAG-linked readable/mutable steps as standalone callable endpoints, so later agents can resume or invoke a single step without replaying the whole flow.
- Exact-URL search resolves should reject cached/marketplace skills that do not expose the same explicit search binding (for example `?q=`); obvious misses should return quickly, not trigger browser/capture side effects.
- Resolve should also reject generic feed/timeline skills for messaging intents; if the cache has no real inbox/message route, return a miss instead of a fake LinkedIn feed hit.
- Generic/auto endpoint descriptions must not be treated like reviewed truth: captured page/search-form artifact strings should lose the big description-match boost, and resolve/publish should surface description provenance plus a review warning.
- Fresh local DOM fallback labels like `Search form for <domain>` / `Page content from <domain>` are also auto-generated junk, not agent-reviewed descriptions.
- The publish-review step should be the main contract-writing surface: expose op-graph context there (dependencies, unlocks, provenance, trigger siblings, requires/provides), and when an agent submits a reviewed description mark it as reviewed/agent-authored.
- Publish review should expose the concrete replay contract too: safe request params, response fields, prerequisites, token bindings, and next-state, and `/review` should be able to persist agent-authored request/response schema annotations instead of only descriptions.
- Remote publish must be review-gated at the shared publish choke point, not just the CLI happy path, so background auto-publish after `sync`/`close` cannot leak unreviewed auto-generated contracts.
- DAG linkage should include low-confidence hint edges for alias/family matches across surfaces, not just exact binding-key equality, so publish review can reason over likely input/output matches from DOM, HTML, JS-derived, and API-derived artifacts.
- DAG hint inference should also use observed value overlap, not just key/family names, and unix-string `observed_at` values must be parsed as real timestamps so valid cross-step edges are not dropped.
- Browse checkpointing should reuse the richer passive-capture recovery path (Performance API replay + HAR replay), and if a session still ends with zero network evidence it must defer with `mode:"none"` instead of caching a fake DOM/search-form skill.
- Passive browse harvest must treat Performance API URL hints as prioritization, not a hard gate: API-style preload resources (for example `api.* /v2/.../*.json`) should still be replayed or at least surfaced as synthetic requests even when the page slug and API path do not lexically match.
- Reverse-engineering should keep generic path-binding candidates first and let the later graph/semantic/review layer name them from evidence; do not bake site-specific semantic names directly into early URL normalization or path templating.
- Fresh live browse captures are publish-side artifacts first: after `sync` / `close`, inspect with `skill` / `publish --pretty`, review, and publish before expecting `resolve` to surface them for reuse.
- Resolve should be the single public primitive: fast cached-domain search plus execute on hit, with no browser side effects on misses. Capture/index/publish stay off the hot resolve path unless explicitly forced.
- Resolve should return the whole relevant DAG slice for the chosen intent, not just a flat shortlist, and safe GET dependents should be surfaced as prefetch hints/context for later steps.
- Packaged runtime health/version checks should read the installed package version from the nearest package root when available, and fall back to the embedded release manifest inside compiled binaries.
- Local/source runtimes must never send partial release attestation headers; send both release manifest + signature together or omit both so strict backends do not reject dev publish with `release_manifest_incomplete`.
- The MCP tool surface must mirror `SKILL.md`: `resolve` is cache-only, and fresh live captures must flow through `go -> sync/close -> skill/publish -> review -> publish`, with explicit MCP `review`/`publish` tools available so agents do not improvise discovery through `resolve`.
- Treat `npx skills add ... --skill unbrowse` as instructions-only. If the `unbrowse` binary/runtime is missing, the agent should tell the user to install the runtime (`npm install -g unbrowse@preview && unbrowse setup`, or `... --host mcp`) instead of assuming the skill install was enough.
- `unbrowse_resolve` MCP misses should return explicit browser-first next steps (`go -> snap -> interact -> sync/close -> skill/publish -> review -> publish`) so agents follow the default live-capture flow instead of waiting on cache-only resolve.
- `unbrowse_resolve` MCP misses should also return explicit relevant option sets (`browse_only`, `capture_for_reuse`, `auth_then_retry`) in the tool result itself, so agents can choose the right live path from context instead of improvising.
- Explicit browser `go` flows should treat Kuri startup aborts and temporary connect failures as recoverable browse-session errors, so login/messaging learns retry instead of failing during warmup.
- Browse mode should stay thin: `go` opens a fresh Kuri session unless the caller explicitly passes `session_id`, and read ops should not silently reset/recover or rebind onto replacement tabs.
- Unbrowse local/runtime uses the vendored Kuri binary under `packages/skill/vendor/kuri/...`; patching `submodules/kuri` alone is not enough for real-path verification unless the vendored binaries are rebuilt.
- `origin/lewis/experiments` is the sandbox branch; its Cloudflare deploy should stay isolated on workers.dev and use its own `EXPERIMENTS_API_URL` secret/var instead of sharing staging preview config.
- Use the repo `experiments` preset for `lewis/experiments` runtime tests; it should stay publish-enabled but isolated from the main `prod` local profile.
- Preview npm/binary releases should be built with an embedded default backend URL at build time, not only a wrapper env override, so downloaded compiled binaries talk to the intended preview backend by default.
- staging/experiments frontend deploys should use `wrangler deploy` after `opennextjs-cloudflare build`; the direct OpenNext deploy path tries to prefill R2 incremental cache and 403s under current CI credentials.
