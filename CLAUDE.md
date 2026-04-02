# CLAUDE.md

## Project

Unbrowse — API-native agent browser powered by Kuri. Discovers internal APIs (shadow APIs) from real browsing traffic and progressively replaces browser calls with cached API routes. Monorepo with bun workspaces.

## North Star

Reduce the number of steps to achieve any goal with Unbrowse. Continuously self-optimize by running new use cases, identifying where too many steps are needed, and fixing the pipeline so fewer steps are required next time. Every manual `go → snap → click → close` sequence should eventually become a single `resolve` call.

## Architecture

- **Kuri is the primary browser** (Zig-native CDP broker, 464KB, ~3ms cold start). Unbrowse is the intelligence layer on top.
- **`HEADLESS=false`** is required when spawning Kuri — enables stealth extension (anti-bot) + `--user-data-dir` for persistent Chrome profile.
- **Cookie injection**: on `go`/`goto`, cookies are extracted from user's real Chrome/Firefox SQLite DB and injected into Kuri's tab via `setCookie`. Kuri auth profiles (Keychain) are loaded/saved per domain automatically.
- **Passive capture**: HAR recording + fetch/XHR interceptor (`INTERCEPTOR_SCRIPT`) run on every browse session. On `close` or navigation, captured traffic goes through the full enrichment pipeline.
- **Full enrichment pipeline** (same for passive and explicit capture): `extractEndpoints` → `extractAuthHeaders` → `storeCredential` → `mergeEndpoints` (with existing domain skill) → `generateLocalDescription` → `augmentEndpointsWithAgent` (LLM semantic metadata) → `buildSkillOperationGraph` → `cachePublishedSkill` → `queueBackgroundIndex` (marketplace publish).
- **Resolve pipeline**: route cache → marketplace → first-pass browser (8s) → browse session handoff (agent drives) → live capture fallback.
- **Browse session handoff**: on resolve miss, if first-pass has a tab, Unbrowse opens a browser session with auth/interceptor and returns `{ status: "browse_session_open", next_step: "unbrowse snap" }`. The calling agent drives the browser; Unbrowse indexes passively.
- **Sync to public repo**: `bash scripts/sync-skill.sh` or manual rsync to `~/Projects/unbrowse-skill` + push to `unbrowse-ai/unbrowse` stable branch.

## Known Issues to Fix

- **Endpoint routing picks wrong template match** — e.g. Reddit r/singularity resolve executed r/programming endpoint instead. URL template params need better semantic matching, and skill/endpoint descriptions should be reverse-engineered by the LLM to capture what each endpoint actually does (subreddit name, query params, etc.).
- **Kuri HAR misses async fetch/XHR** — HAR recording via CDP doesn't capture all requests on SPAs. The JS interceptor (`INTERCEPTOR_SCRIPT`) catches what HAR misses. Both sources must be merged on close.
- **Stale marketplace skills** — old skills with non-functional endpoints still rank high in resolve. Need staleness detection + auto-deprecation.
- **X.com timeline API not captured passively** — X's GraphQL HomeTimeline uses POST with massive JSON body that `extractEndpoints` filters out. Need to handle GraphQL POST endpoints with `operationName` extraction.
## Structure

- `src/` — shared skill engine (capture, reverse-engineer, execute)
- `backend/` — Cloudflare Worker API (marketplace, stats)
- `frontend/` — Next.js landing page
- `packages/skill/` — isolated publishable skill package (src/ symlinks to root)

## Conventions

- All notable changes must be written into `CHANGELOG.md`
- Use conventional commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`
- Use `bash scripts/sync-skill.sh` to publish skill changes to `unbrowse-ai/unbrowse`
- Kuri must work as a bundled runtime from the package/monorepo vendor path. Do not require end users to install Zig or a separate `kuri` binary.
- When touching Kuri discovery, packaging, runtime paths, or `packages/skill`, run `bash scripts/check-packaged-kuri.sh`.

## Codex Eval Harness

- Refresh the local npm package first for manual smoke checks:
  - `cd packages/skill && npm pack`
  - install the tarball into a temp dir
  - use the installed `./node_modules/.bin/unbrowse` binary
- Canonical interactive eval path: `bun run eval:codex`
- Canonical product-success suite: `bun run eval:codex:product-success`
- Stress suite: `bun run eval:codex:stress`
- Compatibility aliases:
  - `bun run eval:codex:public` -> product-success
  - `bun run eval:codex:agent-targets` -> stress
- Use product-success for product claims:
  - task/result pages
  - param-seeded search tasks
  - resolve -> agent review -> optional execute
- Use stress for breadth only:
  - benchmark-style sites
  - niche public forums/search pages
  - homepage-heavy / hostile surfaces
- Final evaluation happens in-thread by the agent reviewing the artifact
- Every eval case stops at resolve; artifact stores collector status only (`ready_for_review`, `fail`, `skip`)
- The agent judges shortlist quality in-thread; execute is optional and only for deeper validation
- Pass `--params '{...}'` when you need to prove the agent populated query/template inputs instead of relying on query state already present in the page URL
- Use one case first; only use case files after the single case passes
- Prefer `--intent ... --url ... --force-capture` while fixing regressions
- Artifact of record: `evals/codex-harness-last-run.json`
- Compact shortlist view: `evals/codex-harness-last-run.review-queue.json`
- Read artifact before patching again:
  - resolve excerpt
  - deferred endpoint shortlist
  - selected order
  - `agent_review.execute_candidates`
  - direct-result excerpt when resolve already returned structured data
  - query source (`url`, `params`, or `mixed`)
  - graph selection + dependency-walk summary
  - local signals
- Use the review-queue sidecar for batch agent judging:
  - top candidates only
  - compact signals (`schema`, `templated_url`, `page_artifact_risk`, ...)
  - direct execute commands
- If auth is needed, make sure local vault/browser cookies already exist first
- Do not add new parallel eval harnesses; extend `evals/codex-harness.ts` or its helpers instead

## Releases

When asked to release, follow this flow:

1. Read commits since last tag: `git log $(git describe --tags --match='v*' --abbrev=0)..HEAD --format="%s"`
2. Read the diff of user-facing code (src/, packages/, SKILL.md, README.md)
3. Write polished, user-facing release notes to `.release-notes.md` (see format below)
4. Run `bun run release` — bumps version, updates CHANGELOG, tags, creates GitHub Release using the notes
5. The tag push triggers CI which deploys backend + frontend and syncs + releases the skill repo

### Release notes format (.release-notes.md)

Write for developers and AI agent builders. Focus on what users can do now, not implementation details. Skip internal/backend-only changes. Use this structure:

```
## What's New
(1-2 sentences per feature)

## Fixes
(1 line per fix)

## Performance
(1 line with before/after numbers if available)
```

Omit empty sections. No emojis. No file paths or function names.

### Config

- `release-it` with `@release-it/conventional-changelog` (config: `.release-it.json`)
- Versions synced across: `package.json`, `packages/skill/package.json`, `version.json`
- Do not bump versions or create tags manually — `release-it` handles it

## GitHub

- Only create PRs and issues — do not push directly to main
- Secrets needed for releases: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SKILL_REPO_TOKEN`

- **`src/kuri/client.ts` is now extended by Unbrowse** — auth profile methods, `HEADLESS=false`, cookie injection. Coordinate with Kuri submodule on `adding-extensions` branch when updating.
- **Never edit `src/kuri/client.ts`** unless explicitly asked. Kuri is a separately maintained Zig binary; its Node client wrapper is fragile and tightly coupled.
- **Always kill the running unbrowse server** after `npm i -g` before testing. The old process keeps serving stale code. Run: `pkill -9 -f 'unbrowse|kuri'; sleep 2` then retry.
- **Guard HAR entry iteration**. Kuri HAR entries may have `undefined` headers/response fields. Always use `entry.request.headers ?? []`, never bare `entry.request.headers`.
- **Guard kuri evaluate results**. `kuri.getCurrentUrl` and `kuri.getPageHtml` may return `"[object Object]"` when Kuri's CDP response shape changes. Validate URL starts with `http` and HTML starts with `<`.
- **`rach/restart-base` is the working branch**, not `main`. Main is broken. Do not merge from or rebase onto main.
- **`autoExtract` must be `true`** in `executeBrowserCapture`'s cookie resolution. Setting it to `false` silently skips browser cookie extraction and breaks all gated sites.
- **Packaged CLI spawns a separate server process**. `bun src/cli.ts` runs inline (same process), but `unbrowse` (global install) spawns a detached node+tsx server. Stale servers are the #1 cause of "works from source, broken from package".
- **Never mock in tests**. Tests must hit real endpoints, real files, real functions. Mocked tests pass when prod is broken — they prove nothing. Use live backend URLs (gated behind env vars for CI), real filesystem temp dirs, and actual function calls. If a test can't run without mocking, the code is too coupled — fix the code, not the test.
- **Backend URL is `beta-api.unbrowse.ai`**, not `api.unbrowse.ai`. The `UNBROWSE_API_URL` env var overrides this.

## Testing

- **Always use `/codex` to run tests**. Do not write test assertions by hand — use the `/codex` plugin to generate and execute all unit tests, e2e tests, and regression tests. This prevents fabricated/hallucinated test results.
- **Never fake a passing test**. If a test can't be run, say so. Do not write a test that asserts hardcoded expected values you haven't verified by actually running the code.
- **Run tests after every code change**. Use `bun test <file>` for targeted runs. All graph/DAG tests: `bun test tests/graph-*.test.ts tests/dag-*.test.ts`. Sanitization: `bun test tests/sanitize-for-publish.test.ts`.
- **Tests must hit real code paths** — no mocks, no stubs, no fake HTTP responses. If a test needs a network call, gate it behind an env var for CI, don't mock it.
- **Bug fix protocol**: when a bug is reported, write a failing test FIRST that reproduces it, then fix the code and verify the test passes.
