# CLAUDE.md

## Project

Unbrowse — API-native agent browser powered by Kuri. Discovers internal APIs (shadow APIs) from real browsing traffic and progressively replaces browser calls with cached API routes. Monorepo with bun workspaces.

## North Star

100x traction is the standing goal. Every action should be evaluated against this. If it doesn't drive installs, usage, or retention — don't do it.

Baselines (Apr 2): 611 stars, 5.4K npm downloads, 819 keys, 197 WAU, 88 executions, 3 marketplace endpoints.

Reduce the number of steps to achieve any goal with Unbrowse. Continuously self-optimize by running new use cases, identifying where too many steps are needed, and fixing the pipeline so fewer steps are required next time.

## Agent UX North Star

Every code change is judged against the calling agent's experience. The four invariants:

1. **Two tool calls is the contract — never one.** Resolve returns a ranked shortlist with rich evidence (URL, score, sample values, requires/yields, schema, action_kind). The agent's LLM picks which endpoint matches the intent and calls execute. Auto-exec is opt-in (`--execute` flag, opt-out by default). The picker is the calling LLM, not us. Our job is to filter wrong endpoints out of the shortlist and surface the right evidence on the rest.
2. **Less errors.** Filter the wrong/noise/error-shaped endpoints OUT at admission and resolve so the shortlist contains only callable, intent-relevant ones. Better: zero ops with an actionable `next_step` than three ops where two are wrong.
3. **Correct retrieval.** When the agent picks an endpoint and calls execute, the URL must reflect the user's contextUrl entity (A8). Wrong-template / cross-subdomain / cross-brand / phantom / captured-error / write-on-read endpoints must rank below real ones (A1, A1.1, A1.2, A10, A12, A13, G1, C5).
4. **Works for what was asked.** If the intent is "search jmail for X", the agent gets X back, not the schema, not extraction_hints. `--raw` semantics are the default truth (auto-extract only fires above 64KB); `--extract` is a convenience.

**Browser-open is failure mode, not feature.** Every browser-open during normal operation is a multi-second, multi-step event the agent must drive. Optimize for never opening one:
- Kuri runs `--headless=new` on every platform (`src/kuri/client.ts:resolveKuriLaunchConfig`). Production must NEVER pop a window onto the user's screen. Visible windows only on `HEADLESS=false` for explicit dev/auth flows.
- Resolve must exhaust marketplace + cache + entity-substituted captured URLs (A8) before falling back to live capture.
- When live capture is unavoidable, return an actionable `next_step` (`open_browse_session` / `abandon_or_authenticate`) with concrete `suggested_commands`. Never a one-word error.
- Same-host empty-resolve must hard-handoff (resolve_hard_handoff) instead of letting the agent loop re-resolving.

**Stickiness strategy:** Make Unbrowse the default browser for every agent via MCP + SDK. If Unbrowse is the MCP server agents call for ANY web task, it becomes infrastructure — not a tool you choose, but the layer everything routes through. Priority: Claude MCP server (exists), `@unbrowse/sdk` (v6.15.0 — spawns the local binary itself, so `npm i @unbrowse/sdk` is enough; no global install required), OpenClaw plugin (exists v0.7.13), LangChain/CrewAI integrations (code written).
## Architecture

- **Kuri is the primary browser** (Zig-native CDP broker, 464KB, ~3ms cold start). Unbrowse is the intelligence layer on top.
- **Kuri defaults to headless on every platform** (Apr 2026 change in `src/kuri/client.ts:resolveKuriLaunchConfig`). Chrome runs `--headless=new`, which keeps the stealth extension and `--user-data-dir` persistence working. Set `HEADLESS=false` (or `KURI_HEADLESS=false`) only for dev/auth paths that need a visible window — `src/auth/index.ts` already does this for interactive auth, and the dev-side harness opts in the same way. Production unbrowse must never pop a window onto the user's screen.
- **Cookie injection**: on `go`/`goto`, cookies are extracted from user's real Chrome/Firefox SQLite DB and injected into Kuri's tab via `setCookie`. Kuri auth profiles (Keychain) are loaded/saved per domain automatically.
- **Passive capture**: HAR recording + fetch/XHR interceptor (`INTERCEPTOR_SCRIPT`) run on every browse session. On `close` or navigation, captured traffic goes through the full enrichment pipeline.
- **Full enrichment pipeline** (same for passive and explicit capture): `extractEndpoints` → `extractAuthHeaders` → `storeCredential` → `mergeEndpoints` (with existing domain skill) → `generateLocalDescription` → `augmentEndpointsWithAgent` (LLM semantic metadata) → `buildSkillOperationGraph` → `cachePublishedSkill` → `queueBackgroundIndex` (marketplace publish).
- **Resolve pipeline**: route cache → marketplace → first-pass browser (8s) → browse session handoff (agent drives) → live capture fallback.
- **Browse session handoff**: on resolve miss, if first-pass has a tab, Unbrowse opens a browser session with auth/interceptor and returns `{ status: "browse_session_open", next_step: "unbrowse snap" }`. The calling agent drives the browser; Unbrowse indexes passively.
- **Skill path retired in v6.15.0** — SDK is the integration surface, MCP is the agent protocol, `unbrowse setup` bootstraps both. No more `SKILL.md` or `unbrowse-ai/unbrowse` skill-repo sync.
- **x402 sponsor tier (v6.15.0)** — `backend/src/middleware/sponsor.ts` gates every paid execute through a per-agent + per-platform daily USD cap. Lewis's wallet sponsors first $1/day/agent and $50/day/platform; agents fall through to their own x402 wallet once caps trip. State lives in KV: `sponsor:agent:<id>:<UTC-date>`, `sponsor:global:<UTC-date>`, `sponsor:ledger:<id>`. Exposed via `GET /v1/account/sponsor-status` and admin ledger at `GET /v1/admin/sponsor-ledger` (ADMIN_KEY-gated).

## Known Issues to Fix

- **Endpoint routing picks wrong template match** — e.g. Reddit r/singularity resolve executed r/programming endpoint instead. URL template params need better semantic matching, and skill/endpoint descriptions should be reverse-engineered by the LLM to capture what each endpoint actually does (subreddit name, query params, etc.).
- **Kuri HAR misses async fetch/XHR** — HAR recording via CDP doesn't capture all requests on SPAs. The JS interceptor (`INTERCEPTOR_SCRIPT`) catches what HAR misses. Both sources must be merged on close.
- **Stale marketplace skills** — old skills with non-functional endpoints still rank high in resolve. Need staleness detection + auto-deprecation.
- **X.com timeline API not captured passively** — X's GraphQL HomeTimeline uses POST with massive JSON body that `extractEndpoints` filters out. Need to handle GraphQL POST endpoints with `operationName` extraction.
- **MCP UX gaps vs CLI** — see [`docs/mcp-vs-cli-ux-audit.md`](docs/mcp-vs-cli-ux-audit.md). `src/mcp.ts` has command parity with the CLI but `listChanged: false`, hints are prose-only `_workflow_hints` instead of structured `next_action`, and no `workflow:*` recipe prompts. Verify claims still hold: `bash scripts/verify-mcp-audit.sh`.
- **MCP workflow guide** — step-by-step tool-call sequence for callers, see [`docs/mcp-workflow-guide.md`](docs/mcp-workflow-guide.md). Three intent classes (cached / cold-browse-publish / URL-contents), all 33 tools referenced with `src/mcp.ts:LINE` cites. Falsifier: `bash scripts/verify-mcp-workflow-guide.sh` (length, coverage, citation-content match).
## Structure

- `src/` — local server (resolve, execute, capture, MCP) — what the CLI/MCP run against
- `backend/` — Cloudflare Worker API (marketplace, stats, sponsor middleware)
- `frontend/` — Next.js landing page
- `packages/sdk/` — `@unbrowse/sdk` — thin TS client; `spawn()` factory auto-starts the local binary
- `packages/skill/` — npm package that publishes the CLI binary (`unbrowse`); not a Claude skill


## Conventions

- All notable changes must be written into `CHANGELOG.md`
- Use conventional commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`
- Skill path retired in v6.15.0 — integration surface is `@unbrowse/sdk` + MCP; no skill-repo sync.
- Kuri must work as a bundled runtime from the package/monorepo vendor path. Do not require end users to install Zig or a separate `kuri` binary.
- When touching Kuri discovery, packaging, runtime paths, or `packages/skill`, run `node packages/skill/scripts/assert-kuri-vendor.mjs`.
- **Pre-commit hook fails on merge commits when `submodules/kuri/` is empty.** `prepare-pack.mjs` throws "Broken Kuri source checkout". For merge commits where the submodule isn't relevant, use `git commit --no-verify`. For non-merge commits, run `bash scripts/ensure-submodules.sh` first.
- **`EndpointDescriptor` lives in three files; all must stay in sync.** `backend/src/types.ts` (worker), `src/types/skill.ts` (CLI/MCP), `frontend/src/lib/api.ts` (Next.js). Same for `SkillManifest`. New endpoint fields must land in all three or the Next.js build fails with TS2339.
- **Squash-merged PRs disappear from main's history.** Branches built on top of the original commit (e.g. `56a606db` from PR #430) produce dozens of `AA` (add/add) conflicts when merging origin/main. Resolution rule: `git checkout --theirs <files>` for files the branch never touched, `git checkout --ours <files>` for files the branch rewrote. Then a clean merge commit on top.

## bench-local (fastest iteration loop)

Primary loop when investigating coverage regressions: `bash scripts/bench-local.sh --use-source --corpus-file F --timeout 90`. Uses `bun src/cli.ts` inline (no package reinstall, no server spawn, no CI flakiness). Writes `.bench-local/{results.jsonl,evidence.csv,*.out}` + prints the rubric tally on stderr.

### Evidence fields the agent reads

Every row in `results.jsonl` / `evidence.csv` includes:

- `source` — `marketplace` | `live-capture` | `dom-fallback` | `cache` | `` (no response)
- `trace_success` + `trace_skill_id` — top-level trace outcome
- `has_available_operations` + `n_operations` — shortlist size
- `error_code` + `error_message` — what the product returned
- `captured_html_bytes`, `captured_text_bytes`, `captured_title`, `captured_api_calls`
- `captured_intent_verdict`, `captured_intent_reason` — `assessIntentResult` on stripped text
- `filter_rejections` — JSON map of `{reason: count}` from extractEndpoints (`not_api_like`, `score_non_positive`, `body_not_json_or_html`, `domain_mismatch`, `semantic_entity_mismatch`, `rsc_payload`, `ad_response`, `cloudflare_challenge`, `protobuf_unparseable`)
- `browser_block_signals` — JSON list of signals: `challenge_title`, `vendor:cloudflare|perimeterx|datadome|imperva_incapsula|akamai_bot_manager|captcha_vendor|shape_security|kasada`, `sparse_capture_mostly_noise`, `empty_capture`, `no_html_many_apis` (kuri getPageHtml failed but network fired)
- `capture_diagnostic` — set on `No relevant endpoint discovered` rejection path, one of: `no_endpoints_extracted` (browser-blocked upstream), `all_endpoints_filtered_by_noise_rules` (ranker killed everything), `endpoints_scored_below_relevance_threshold` (scoring issue)
- `total_endpoints_captured` — raw count before ranking, transparency for the above diagnostic

### Agent rubric for classifying bench-local rows

Apply in order (first match wins):

| Bucket | Condition | Counted? |
|---|---|---|
| `BROWSER_BLOCK` | `browser_block_signals` contains `vendor:*`, `challenge_title`, or `no_html_many_apis` | Excluded from coverage |
| `BROWSER_BLOCK` | `capture_diagnostic` in (`no_endpoints_extracted`, `all_endpoints_filtered_by_noise_rules`) | Excluded from coverage |
| `AUTH_GATED` | `error_code == "auth_required"` | Excluded from coverage |
| `PASS` | `has_available_operations == true && n_operations > 0` | ✓ Pass |
| `PASS` | `trace_success == true && source == "dom-fallback"` | ✓ Pass |
| `PASS` | `trace_success == true && source == "direct-fetch"` | ✓ Pass (raw body returned) |
| `SPARSE_REVIEW` | `browser_block_signals` contains only `sparse_capture_mostly_noise` (no vendor) | Agent judges in-thread |
| `PRODUCT_FAIL` | anything else | ✗ Fail |

Coverage metric: **`PASS / (PASS + PRODUCT_FAIL + SPARSE_REVIEW)`**. Never include browser-blocked or auth-gated sites in the denominator — they're not our bug to fix. The stop hook's "100% coverage unless browser-blocked" maps directly to this formula.

### When a row is `SPARSE_REVIEW`

Read `rejected_samples` and `captured_title` for that row's `.out` file. If the rejected URLs look like pure anti-bot telemetry (perimeterx/datadome/cloudflare collectors, tracking beacons, data: URLs), reclassify as `BROWSER_BLOCK`. If they look like real data endpoints the filter ate, add it to `.bench-learned-problems/` as a new product issue and extend the extractor.

### When a row is `PRODUCT_FAIL`

Look at `filter_rejections`: if one bucket dominates, read the corresponding rejected_samples to see if real data endpoints were dropped. Use the pattern from commit 688c79ad (graphql bypass, sibling-subdomain bypass, SPA URL convention bypass) to add targeted filter relaxations. Always add a matching test to `tests/extraction-filter-bypass.test.ts` so the unblock can't silently regress.

## Agent-Experience Harness (canonical evaluator)

The agent-experience harness is the source of truth for "is unbrowse working
for real intents?" — a harness-collects / agent-judges flow with no regex/grep
verdicts. Replaces the prior codex-harness eval pipeline (Apr 2026).

- Run: `bun run agent-xp` (corpus) or `bun run agent-xp:judge` (corpus + judge banner)
- Corpus: `harness/probes/corpus.txt` (one `intent|url` per line; grow as needed)
- Probe runner: `harness/probes/agent-experience.sh`
- Judge protocol: `harness/probes/JUDGE.md`
- Per-run artifacts: `harness/runs/<run-id>/{NNN.json, NNN.log, manifest.json}`

The harness only collects evidence (source, available_operations,
available_endpoints, kuri_pids_alive_after_run, visible_chrome_present,
durations, diagnostic). The verdict comes from an LLM agent reading
`manifest.json` against `JUDGE.md` — not from any assertion in this repo.

Structural invariants (headless default, spawn-gate, mirror parity, vendor
binary presence) stay as `bun test tests/*.test.ts` — those check things
heuristics CAN catch in 250ms.

### Codex Eval (programmatic, resolve-only)

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

## Ranker philosophy: heuristics OUT, primitives + LLM judge IN

The deterministic ranker (`rankEndpoints` in `src/execution/index.ts`) keeps
only EVIDENCE-DERIVED, GENERIC signals: BM25 over the endpoint's own text,
URL-path keyword overlap with intent, schema richness, host pattern (api./io./
docs.), method tiebreak, response-shape bonuses. Per-domain registries (e.g.
"if domain == x.com and path == /search then op SearchTimeline +220") are
banned — they don't generalize and they masquerade as judgment.

When BM25 ties or descriptions are sparse (typical on GraphQL ops with shallow
agent-augmented metadata), disambiguation is delegated to an LLM judge via the
`unbrowse rank --intent X --url Y` primitive (script: `harness/probes/rank-
evidence.sh`). The primitive emits the top-N candidates' evidence as JSON; the
agent or a judge sub-agent reads the evidence and picks. The verdict is NOT a
regex.

Same principle for GraphQL ergonomics: `decomposeGraphqlEndpoint` parses the
captured `variables` JSON shape and surfaces flat keys with example values
(structural primitive, not a registry). It does NOT carry a `q → rawQuery`
alias table — agents read `agentParams[].key` to see the real field names, or
an LLM judge reshapes flat user input into the GraphQL shape on the way in.

### Anti-patterns: per-domain heuristics that don't generalise (NEVER ADD MORE)

Every site-specific shortcut you add is a tax we pay forever. The 11th site
gets it wrong, the agent calls a stale URL, no one notices. Below are real
violations already in the codebase — fix or delete, never extend.

**✅ CASE STUDY: per-host registry deleted (Phase 8.3)**

`deriveStructuredDataReplay` had 16 site arms (mastodon, gitlab, github,
hn.algolia, huggingface, mdn, dev.to, npmjs, pypi, pub.dev, hub.docker,
rubygems, stackoverflow, jmail.world, reddit). It was @deprecated in
Phase 7 once the probe-first executor + proven_recipe replay subsumed its
behaviour generically, and DELETED in Phase 8.3 after one release proved
no caller depended on it. The companion `endpoint.exec_strategy` field and
its carry-forward machinery went with it.

The audit grep is now expected to return zero hits in src/:

```bash
grep -rn 'host === "[a-z]' src/ | grep -v 'auto"\|unknown"\|codex"\|claude"'
```

If a host comparison reappears, the same migration pattern applies: write a
structural primitive that handles the case generically (read
`<link rel="alternate" type="application/json">`, follow LD-JSON
`mainEntity`, parse OpenSearch descriptors, look at sitemap.xml hints), ship
it in a deprecation window, then delete the registry in the next phase.

**🚫 BAD: single-segment-only A8 entity substitution**

```ts
if (diffCount === 1) { /* substitute */ }   // pre-fix; ignored reddit posts
```

Reddit `/r/{sub}/comments/{id}/{slug}` differs in 3 segments. Hardcoding
`=== 1` was a heuristic disguised as a safety check. Generalise to "any
number of differing segments where every diff pair is entity-shaped on
both sides" (now in `src/execution/index.ts` near A8).

**🚫 BAD: confidence switch with hardcoded type list (`computeConfidence`)**

```ts
case "spa-nextjs": confidence = 0.9;
case "json-ld":    confidence = 0.9;
case "itemlist":   confidence = 0.9;
default:           confidence = 0.3;   // anything new silently fails 0.5 gate
```

Adding a new extractor type silently fails the quality gate at 0.50 < 0.5.
Hit this on `article` extractor — needed a new switch arm. Better: derive
confidence from structural signals (sample size, schema richness, sample
text length) so unknown types still score reasonably.

**🚫 BAD: any new file containing `if (host === "<domain>")` or
`if (skill.domain === "<domain>")`**

If you find yourself typing one of these, stop and ask:
- What URL/page signal is on every site I want to handle, not just this one?
- Can I read it from the response headers, the HTML metadata, or a manifest?
- If it's truly site-specific, can it be a captured-skill descriptor instead
  of code in the runtime?

**Audit cadence:** Run this grep before every minor release:

```bash
grep -nE 'host === "[a-z]' src/ | grep -v 'auto"\|unknown"\|codex"\|claude"'
```

Anything new is a new debt. Either rewrite to a generic primitive or delete.

## Releases

When asked to release, follow this flow:

1. Read commits since last tag: `git log $(git describe --tags --match='v*' --abbrev=0)..HEAD --format="%s"`
2. Read the diff of user-facing code (src/, packages/, README.md)
3. Write polished, user-facing release notes to `.release-notes.md` (see format below)
4. Run `bun run release:preview` — tests, bumps version, tags, pushes, waits for npm, runs remote agent-xp
5. The tag push triggers CI which publishes the CLI to npm and deploys backend + frontend.

### Post-release agent experience review (MANDATORY)

After every release, run the agent experience harness and **judge the artifacts yourself**:

```bash
bash scripts/agent-experience-test.sh --remote lekt8@89.169.121.108
```

This outputs JSON with real workflow artifacts. Review each task:

| Task | Pass if | Fail if |
|------|---------|---------|
| health | `status: "ok"`, version matches release | missing, wrong version |
| resolve | `available_operations` has 1+ endpoints with `endpoint_id` | empty ops, error |
| execute | `success: true`, `status_code: 200`, response has domain-relevant data | empty data on `--raw`, error |
| search (parameterized) | agent-filled `{q}` param returned results | empty after param fill |
| feedback | `ok: true` | error |
| browse_go | `ok: true`, `session_id` present | all 3 retries failed = investigate |
| browse_eval | result contains page content (title, h1, body length) | CDP error, empty |
| browse_snap | a11y tree with `[e0]` root | empty snapshot |
| browse_close | `ok: true`, `endpoint_count >= 0` | error |

If execute returns `data: []` with `--extract`, retry with `--raw` — extraction path mismatch is not a pipeline failure. Judge the raw response.

If browse skips on remote (cold Kuri start), that's a known timing issue — not a release blocker unless resolve/execute also fail.

**Do not ship a release without reviewing these artifacts.** Grep-based pass/fail is not sufficient — the agent must judge whether the data makes sense for the intent.

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
- **Auto-spawned Fastify daemon is the real footgun**. When the unbrowse MCP server starts (`bun src/mcp.ts`), it auto-spawns a detached Fastify HTTP daemon at `localhost:6969` so MCP tool handlers can `fetch()` real routes. The MCP stdio process itself is stateless-per-call — the daemon is what lingers. As of Phase 2 (commit chain `7282cfc6..6e21ef90`):
  - `MCP_SERVER_MODE=1` (set automatically when MCP spawns the daemon) tightens the idle-reaper window to 15 seconds. Without this, the daemon waits 60s for the default reaper after MCP exits.
  - `unbrowse serve` is the explicit foreground command. Use it when you want a long-lived server you control. Defaults `UNBROWSE_SERVE_IDLE_MS=0` (no auto-exit). Kill with SIGTERM/SIGINT for clean shutdown.
  - `--no-auto-start` (CLI flag, `bun src/mcp.ts --no-auto-start`) skips the auto-spawn entirely. Useful when a daemon already exists or when you want to manage it independently.
  - `pkill -9 -f 'unbrowse|kuri'; sleep 2` remains the nuclear option if any of the above leaves a zombie. The "Always kill" rule above still applies for SIGKILL-during-request edge cases that pin the activity bump. Phase 2.1 will revisit after a two-week production observation window.
- **Guard HAR entry iteration**. Kuri HAR entries may have `undefined` headers/response fields. Always use `entry.request.headers ?? []`, never bare `entry.request.headers`.
- **Guard kuri evaluate results**. `kuri.getCurrentUrl` and `kuri.getPageHtml` may return `"[object Object]"` when Kuri's CDP response shape changes. Validate URL starts with `http` and HTML starts with `<`.
- **`autoExtract` must be `true`** in `executeBrowserCapture`'s cookie resolution. Setting it to `false` silently skips browser cookie extraction and breaks all gated sites.
- **Packaged CLI spawns a separate server process**. `bun src/cli.ts` runs inline (same process), but `unbrowse` (global install) spawns a detached node+tsx server. Stale servers are the #1 cause of "works from source, broken from package".
- **Never mock in tests**. Tests must hit real endpoints, real files, real functions. Mocked tests pass when prod is broken — they prove nothing. Use live backend URLs (gated behind env vars for CI), real filesystem temp dirs, and actual function calls. If a test can't run without mocking, the code is too coupled — fix the code, not the test.
- **Backend URL is `beta-api.unbrowse.ai`**, not `api.unbrowse.ai`. The `UNBROWSE_API_URL` env var overrides this.

## Testing

- **Always use `/codex` to run tests**. Do not write test assertions by hand — use the `/codex` plugin to generate and execute all unit tests, e2e tests, and regression tests. This prevents fabricated/hallucinated test results.
- **Never fake a passing test**. If a test can't be run, say so. Do not write a test that asserts hardcoded expected values you haven't verified by actually running the code.
- **Run tests after every code change**. Use `bun test <file>` for targeted runs. All graph/DAG tests: `bun test tests/graph-*.test.ts tests/dag-*.test.ts`. Sanitization: `bun test tests/sanitize-for-publish.test.ts`.
- **For backend security/auth work, list test files explicitly.** Bare `bun test` runs the slow issue-regressions matrix. The targeted set: `bun test ./backend/tests/{skills-trust-promotion,skills-publish-proofs,proof-verifier,x402-skill-route,auth-routes-magic-flow,auth-failure-modes,protected-routes-auth}.test.ts` runs in ~70 ms with full coverage of the publish/auth/x402 surface.
- **Root `bun --bun tsc --noEmit` has ~27 pre-existing errors** in unmodified files (api/routes.ts, browser/index.ts, browser-cookies.ts, etc.). They are baseline noise — diff your error count against `origin/main` before assuming you regressed something. Backend tsc (`bun --bun tsc --noEmit -p backend/tsconfig.json`) is clean and is the better signal for backend changes.
- **codex-cli ≥0.128 quirks.** `codex review --base <branch>` and `[PROMPT]` are mutually exclusive — pass `--base` alone. `mktemp "$DIR/codex-err-XXXXXX.txt"` collides on rerun; use `mktemp "$DIR/codex-err-XXXXXXXX"` (X's must end the template, no extension).
- **Tests must hit real code paths** — no mocks, no stubs, no fake HTTP responses. If a test needs a network call, gate it behind an env var for CI, don't mock it.
- **Bug fix protocol**: when a bug is reported, write a failing test FIRST that reproduces it, then fix the code and verify the test passes.

### Failing-test triage harness

When you have N failing tests across one or more files, do NOT re-run the
full suite per fix attempt. Use the per-test isolation harness — it
caches one suite run and surfaces evidence per failure.

```bash
# 1. List every failing test as actionable rows (cached for 10 min)
bun run test:triage              # human-readable
bun run test:triage:json         # JSON for agent ingestion
bun run test:triage:next         # just the next failure to fix

# 2. Debug one test with full evidence
bun run test:isolate <file-pattern> --name "<test name regex>"
# Emits: parsed assertion (Expected/Received), failing line + 8 lines
# context, SUT files referenced by the test's imports, recent commits
# touching those SUT files, full bun test log.

# 3. Force re-run after fixing
TEST_TRIAGE_REFRESH=1 bun run test:triage
```

Driver loop for a fixing agent:
1. `bun run test:triage:json > .triage.json`
2. For each row: run `isolate_command` from the row, read evidence,
   fix the SUT, re-run isolate
3. When isolate returns exit=0, advance to next row
4. After all rows fixed, `TEST_TRIAGE_REFRESH=1 bun run test:triage` to
   confirm zero remain

Anti-pattern: never add a "test:p0-p1" / "test:category" / "test:cluster"
script that runs many tests under one command without surfacing per-test
evidence — that was the harness we deleted in `975256ac` because it
couldn't tell us which test broke or why without re-running everything.
Every new harness MUST expose `--next` and `--isolate` semantics or
extend `scripts/test-isolate.sh`.

## Session Start Protocol

When Lewis starts a conversation about pipeline, fundraising, or sprint progress, proactively run these checks:

### Pipeline Watchdog
1. Read memory `project_fundraise_status_apr1.md` for last-known pipeline state
2. Check Gmail (via `gws gmail`) for recent investor emails — look for replies to SAFEs, lead candidates, and follow-on threads
3. Query Telegram (via `telegram-query` skill) for DM activity from key investor chat IDs listed in `reference_investor_contacts.md`
4. Cross-reference: flag anyone who's been silent >5 days, anyone where Lewis owes a response, any SAFEs unsigned >3 days
5. Update memory with any new signals found

### Sprint Tracker
1. Pull Linear issues for "20x Traction Sprint (Apr 1-14)" — show status (backlog/in-progress/done)
2. Check traction API (`https://launch.unbrowse.ai/api/traction`) and stats API (`https://beta-api.unbrowse.ai/v1/stats/summary`) for current metrics
3. Compare against sprint targets in `project_20x_sprint.md`
4. Flag overdue issues and blockers

### Content & Marketing Pulse
1. Check Typefully (via `typefully` skill) for scheduled/published posts
2. Check X engagement on recent @getFoundry and @lekt8_ posts
3. Compare against content plan in Linear (GET-12 through GET-17)
4. Flag content that's drafted but not posted

### Nascent GP Prep (active until Apr 10 2026)
1. Track days until Nascent GP meeting (Apr 10, 9am PST)
2. Ensure deck, demo, team intros are ready
3. Pull Granola notes from Jack meeting (`not_TDTFi83iGBdbZD`) for talking points
4. Flag any DD materials Jack's team has requested

### Key investor follow-up cadences
- **SAFEs sent**: nudge after 3 days, escalate after 7
- **Post-meeting silence**: follow up after 3 days, nudge again at 7, flag at 14
- **DD in progress**: check in weekly, send any requested materials within 24h
- **Connectors**: ping monthly for intros, update them on progress when there's news
- **"Keep us posted"**: re-engage when there's a concrete trigger (lead closes, traction spike, paper published)

## GTM Execution Protocol — 100x Flywheel

The flywheel: **Discovery → Install → Use (=Mine) → Earn → Retain → Share → More Discovery**
Every layer below feeds this. If an action doesn't feed the flywheel, don't do it.

### Layer 0: AI Search Visibility (GEO) — HIGHEST LEVERAGE, LOWEST EFFORT
Unbrowse is a tool for AI agents but is invisible to AI search. Fix this first.
| Skill | What it does | Priority |
|-------|-------------|----------|
| `geo-crawlers` | Unblock AI crawlers (GPTBot, ClaudeBot, etc.) in robots.txt | **P0 — DO FIRST** |
| `geo-llmstxt` | Fix llms.txt for AI consumption | P0 |
| `geo-citability` | Make content citable by AI (definition blocks, FAQ, stats) | P1 |
| `geo-schema` | Add structured data (Organization, SoftwareApplication, ScholarlyArticle) | P1 |
| `geo-brand-mentions` | Build brand presence on platforms AI cites (Reddit, GitHub, Wikipedia) | P1 |
| `geo-platform-optimizer` | Optimize for Google AI Overviews, Perplexity, ChatGPT search | P1 |
| `geo-content` | E-E-A-T content quality for AI citability | P2 |
| `geo-technical` | Technical SEO foundations (SSR, Core Web Vitals, crawlability) | P2 |
| `geo-audit` | Full audit — run monthly to track score improvement from 35/100 baseline | P2 |
| `geo-report` / `geo-report-pdf` | Generate client-facing reports (useful for investor updates) | P3 |

### Layer 1: Traditional SEO — Organic Search Discovery
| Skill | What it does | Priority |
|-------|-------------|----------|
| `seo-audit` | Full traditional SEO audit | P1 |
| `programmatic-seo` | Create pages at scale for long-tail keywords ("unbrowse vs playwright", "AI agent browser", etc.) | P1 |
| `schema-markup` | Schema.org structured data for rich snippets | P2 |

### Layer 2: Paid Acquisition
| Skill | What it does | Priority |
|-------|-------------|----------|
| `paid-ads` | X Ads, Google Ads, LinkedIn Ads — strategy, copy, targeting | P1 |
Target keywords: "browser automation alternative", "playwright alternative for AI", "AI agent web tool", "MCP browser"

### Layer 3: Content & Social (Awareness → Install)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `unbrowse-typefully-campaigns` | Plan + schedule X campaigns (USE THIS for posting, not x-cli) | P0 |
| `tweet-writer` | Optimize individual tweets | P1 |
| `x-virality` | X algorithm optimization | P1 |
| `create-viral-content` | Auto-activated on content generation | auto |
| `twitter-thread-creation` | Thread structure + hooks | P1 |
| `hacker-news-strategy` | HN timing, title, comment strategy | P1 |
| `product-hunt-launch` | PH launch optimization | P2 (after traction) |
| `content-strategy` | Long-term content planning | P2 |
| `content-marketing` | Content marketing strategy | P2 |
| `content-calendar` | Schedule + track across platforms | P2 |
| `social-content` | Platform-optimized posts (LinkedIn, X, Reddit) | P1 |
| `social-selling-content-generator` | 30+ LinkedIn posts for dev audience | P2 |
| `reddit` / `reddapi` | Search + engage Reddit threads | P1 |
| `hackernews` | Search + engage HN | P1 |

### Layer 4: Email Campaigns (Direct → Install)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `resend-ab-test` | Tournament-style email AB testing (8 variants ready) | P0 |
| `resend-cli` | Send emails, manage contacts | P0 |
| `resend` | Resend API integration | P0 |
| `email-sequence` | Drip campaign design | P1 |
| `cold-outreach` | Cold email to dev communities | P2 |

### Layer 5: Landing Page & Onboarding (Visit → Install → First Value)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `page-cro` | Landing page conversion optimization | P1 |
| `signup-flow-cro` | Install/signup flow optimization | P1 |
| `onboarding-cro` | Post-install activation optimization | P1 |
| `user-onboarding` | Design onboarding flows | P2 |
| `analytics-tracking` | Set up funnel tracking (install → resolve → mine → earn) | P1 |

### Layer 6: Retention & Growth Loops (Use → Earn → Share → More Users)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `referral-program` | Design referral/invite mechanics (earn more when you invite) | P1 |
| `designing-growth-loops` | Self-reinforcing growth mechanisms | P1 |
| `free-tool-strategy` | Free tools that pull developers in | P2 |
| `community-building` | Community growth tactics | P2 |
| `retention-engagement` | Retention improvement tactics | P1 |
| `measuring-product-market-fit` | PMF assessment and tracking | P2 |

### Layer 7: Developer Ecosystem (Integrations = Distribution)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `gtm-developer-ecosystem` | Developer-led adoption programs | P1 |
| `launch-strategy` | Cross-channel launch planning | P2 |
| `marketing-ideas` | Campaign brainstorming | P3 |

When Lewis asks about GTM, growth, marketing, or content — run these checks and take action:

### Pre-Post Checklist (ALWAYS do before posting to any platform)
1. Search the platform for recent posts from the same account — `x-cli tweet search "from:unbrowse" --max 10`
2. Check for duplicate hooks, repeated phrasing, or same links already shared
4. Check which account x-cli is authed as before posting (currently @unbrowse, NOT @getFoundry)
5. **NEVER use x-cli to post tweets** — always use Typefully (`/typefully` skill) for proper scheduling, analytics, and queue management. x-cli is READ-ONLY (search, metrics, monitoring).

### Blog Publisher
- Skill: `/blog-publisher`
- API key: `BLOG_PUBLISH_KEY=6A3Q4N_lAdWQUtTs1biZzqZGl4BlPJVau8wB8dLn5W4`
- Backend endpoint: `POST https://beta-api.unbrowse.ai/v1/blog/publish` (secured by above key in `Authorization: Bearer` header)
- Accepts: `{ slug, title, description, keywords[], content (markdown), deploy: bool }`
- Generates Next.js page from template, updates sitemap, optionally triggers deploy
- Content Factory remote agent drafts to `.content-queue/`, then blog-publisher publishes

### Traction Dashboard (always check first)
1. Hit `https://launch.unbrowse.ai/api/traction` for: stars, npm downloads, WAU, keys, verifications, retention
2. Hit `https://beta-api.unbrowse.ai/v1/stats/summary` for: marketplace endpoints, executions, agents, hit rate
3. Compare against sprint targets in memory `project_20x_sprint.md`
4. Report delta since last check

### Remote Agents (auto-running, check their output)
1. **Daily Traction Snapshot** — commits `DAILY_TRACTION.md` at 9am SGT
2. **Content Factory** — drafts to `.content-queue/YYYY-MM-DD.md` at 7am SGT
3. **Competitor Intel** — `.intel/YYYY-MM-DD.md` Mon+Thu 1pm SGT

### Supply-Side Growth (the flywheel)
The marketplace fills itself via monetary incentive. Users mine by using Unbrowse — every resolve indexes routes, they earn x402 micropayments. DON'T manually seed — drive users who seed organically.
1. **Email campaigns** drive installs → users use Unbrowse → routes get indexed → marketplace fills
2. **Earnings visibility** (GET-10) is the retention hook — users see "$X earned" and keep mining
3. **First mover bonus**: 2x reward rate for first indexer of a domain
4. Mining quickstart doc: `/Users/lekt9/Downloads/_sorted/content/mining_quickstart.md`

### Email Campaigns (Resend)
Already built and ready to fire:
- **Resend API key**: in memory `reference_resend_api_key.md`
- **OpenClaw stargazer emails**: 234 collected, audience ID `b14d5358-0c7e-422f-89d0-49fefc77c483`
- **Unbrowse stargazer emails**: 118 collected
- **8 AB test variants** ready: `/Users/lekt9/Downloads/_sorted/outreach/openclaw_campaign_variants.json`
  - Best hooks: "cosplay", "mcp-hallucination", "scraped-you", "browser-tax"
- **AB test engine**: `python3 ~/.claude/skills/resend-ab-test/scripts/ab-send.py tournament`
- **Stargazer collection script**: `/Users/lekt9/Downloads/_sorted/outreach/` (needs GITHUB_TOKEN for more)
- Skills: `resend-ab-test`, `resend-cli`, `resend`
- Fire when: earnings visibility is live (GET-10) so users who arrive can see the mining incentive

### X/Twitter — Organic + Paid
**Organic:**
- Post 2-3x/day from @getFoundry (product, benchmarks, demos)
- Post 1x/day from @lekt8_ (founder POV, hot takes)
- Use `x-cli` for posting: `x-cli tweet post "text"`
- Monitor: `x-cli me tweets --limit 10`
- Each morning: review `.content-queue/` drafts, tweak, post
- Skills: `tweet-writer`, `x-virality`, `create-viral-content`, `twitter-thread-creation`

**Paid (X Ads):**
- Use `paid-ads` skill for campaign strategy, targeting, ad copy
- Target audiences: AI agent developers, MCP users, "browser automation" interest, Playwright/Puppeteer users
- Ad angles: "3.6x faster than Playwright", "your agent is browsing — mine calls the API", paper credibility
- Landing page: unbrowse.ai with paper link + `npx unbrowse setup`
- Retarget: website visitors, GitHub stargazers (custom audience from email list)
- Budget: TBD — start small ($50-100/day), optimize for installs
- Use `unbrowse-typefully-campaigns` for campaign planning + scheduling

### Content Pipeline
1. Check Linear GET-12 through GET-17 for status
2. Check `.content-queue/` for Content Factory drafts
3. Existing drafts at `/Users/lekt9/Downloads/_sorted/content/`:
   - `paper_drop_x_thread.md` — X thread for paper launch
   - `email_openclaw_stars.md` — email campaigns (2 audiences)
   - `mining_quickstart.md` — how mining works
   - `clawhub_submission.md` — OpenClaw skill directory listing
   - `product_hunt_listing.md` — PH copy
4. Use `x-cli` to check engagement on recent posts
5. Flag: drafted but not posted, posted but low engagement

### Skill Toolbox
| Skill | When to use |
|-------|------------|
| `unbrowse-growth-os` | Full GTM operating system — sprint playbook |
| `unbrowse-typefully-campaigns` | Plan + schedule X campaigns |
| `paid-ads` | X Ads, Google Ads, LinkedIn Ads strategy + copy |
| `resend-ab-test` | Tournament-style email AB testing |
| `resend-cli` | Send emails, manage contacts |
| `tweet-writer` | Optimize individual tweets |
| `x-virality` | Apply X algorithm logic for spread |
| `create-viral-content` | Auto-activated on content generation |
| `twitter-thread-creation` | Thread structure + hooks |
| `hacker-news-strategy` | HN timing, title, comment strategy |
| `product-hunt-launch` | PH launch optimization |
| `launch-strategy` | Cross-channel launch planning |
| `content-strategy` | Long-term content planning |
| `content-calendar` | Schedule + track across platforms |
| `content-marketing` | Content marketing strategy |
| `social-content` | Platform-optimized posts (LinkedIn, X, Reddit) |
| `social-selling-content-generator` | 30+ LinkedIn posts for prospects |
| `reddit` | Search Reddit for engagement threads |
| `hackernews` | Search HN stories + comments |
| `referral-program` | Design referral/invite mechanics |
| `gtm-developer-ecosystem` | Developer-led adoption programs |
| `community-building` | Community growth tactics |
| `marketing-ideas` | Campaign brainstorming |
| `designing-growth-loops` | Self-reinforcing growth mechanisms |
| `measuring-product-market-fit` | PMF assessment |

### Distribution Channels (ranked by impact)
1. **Resend email campaigns** — 352 stargazer emails ready, 8 AB variants, fire when GET-10 ships
2. **OpenClaw** (344K stars) — clawhub listing + plugin already built (v0.7.13)
3. **arXiv paper** — PUBLISHED: https://arxiv.org/abs/2604.00694
4. **X Ads** — paid amplification of best-performing organic posts
5. **HackerNews** — draft ready, use `hacker-news-strategy` for timing
6. **LangChain PR** — code written at `/Users/lekt9/Downloads/_sorted/integrations/langchain/`
7. **CrewAI PR** — code written at `/Users/lekt9/Downloads/_sorted/integrations/crewai/`
8. **Product Hunt** — copy ready, launch after HN traction
9. **Community** — mtnDAO, hackathon builders, agent Discords
10. **Reddit** — r/MachineLearning, r/LocalLLaMA, r/selfhosted, r/webdev
11. **LinkedIn** — use `social-selling-content-generator` for dev audience
12. **Podcast circuit** — MCG done, pitch more AI/dev podcasts
13. **Newsletter sponsorships** — Ben's Bites, The Rundown, AI newsletters

### Growth Flywheel
```
Email/ads drive installs → users resolve (= mine) → routes indexed → x402 earnings visible
    ↓                                                                         ↓
More endpoints → higher hit rate → faster resolves → more agents attracted → more mining
```
The flywheel is monetary: users earn by using the product. Supply creates demand.

### Weekly GTM Review (every Monday)
1. Pull full traction metrics + compare week-over-week
2. Read `.intel/` for competitive intel + content angles
3. Check Resend dashboard for email campaign performance
4. Review X Ads performance (if running)
5. Update sprint memory with actuals
6. Adjust channel mix based on what's converting
7. Draft investor update if metrics moved
8. Plan content calendar for the week

## Bench verdicts: harness collects, agent judges (harness-collects-agent-judges)

When building benchmarks for unbrowse (or any reverse-engineer / call /
extract loop), DO NOT bake deterministic verdict heuristics into the
harness. The harness collects artifacts; the agent in-thread judges
whether the artifact satisfies the intent.

This is the same principle already documented under
`Agent-Experience Harness` and `Ranker philosophy: heuristics OUT`,
extended explicitly to bench classification.

Anti-pattern (do not do this in extract.py / bench-*.sh / classifier scripts):
```python
if trace.success is True and status_code == 200:
    verdict = "PASS"
if "invalid_replay_params" in err:
    verdict = "REPAIR_REPLAY_PARAMS"
if text_bytes < 100 and "sparse_capture" in signals:
    verdict = "BROWSER_BLOCK"
```

`status_code == 200` does not mean the agent got useful data — could be a
captcha page with HTTP 200, an empty array, or completely wrong shape. The
heuristic verdicts mislead every downstream report and let category errors
silently propagate (e.g. "amazon RE_OK_CALL_OK sc=200" might actually be a
captcha page that didn't return any product listings).

Right pattern (already memorialised in
`feedback_harness_makes_visible_agent_judges.md`):
1. Harness runs the loop and dumps RAW artifacts per URL: capture stdout
   (full skill JSON), per-phase exit codes, execute response body (full,
   not truncated), captured_meta, browser_block_signals.
2. Harness emits a row of EVIDENCE (signals only) per URL — fields like
   `phase1_endpoints_discovered`, `phase2_status_code`,
   `phase2_response_bytes`, `phase2_response_excerpt` (first ~2KB).
   NO verdict column the harness derived from heuristics.
3. The agent (in-thread) reads each row's artifacts and judges:
   "did the agent actually get USB-C cable listings for `intent=search
   amazon for usb-c cables`?" by reading the actual response body and
   matching it against the intent's content expectation.
4. Heuristic groupings (BROWSER_BLOCK / VENDOR_BLOCKED) are a SORT-KEY for
   triage order, NOT a verdict. The verdict is the agent's in-thread
   judgment after opening the artifact.

Reference: `scripts/bench-two-phase.sh` collects per-URL capture.out +
execute.out + runs.jsonl rows. The `combined_verdict` column is a
sort-key only; agent judges by opening artifacts.

This rule applies to ANY bench that produces a per-URL outcome:
bench-two-phase, bench-hard, bench-local, agent-experience harness,
codex eval. Heuristic verdicts in any of these are leaven (1 Cor 5:7).

## Parallel gate collection (deterministic, non-LLM): collector binds the harness-judge split

> STATUS 2026-05-17 (updated): VALIDATED AT conc=4. Both root-cause
> bugs are fixed and falsifier-proven, NOT the `recentLocalSkills` D2
> race I first hypothesized (that guess was wrong). The real causes,
> traced: (1) concurrent `/v1/browse/go` raced `createBrowseSession` so
> sessions cross-bound tabs (probe A rendered probe B) , fixed by
> per-broker create-lock + create-on-unknown-id (commit 41fab174);
> (2) `--headless=new` renderer-backgrounds non-active tabs so
> concurrent snap starved 3/4 , fixed by the standard Playwright
> background-throttle flags in the kuri launcher (commit db9190af,
> re-vendored). `.bench-gate/parallel-isolation-falsifier.sh` now
> PASSES 4/4 (real collector, conc=4, distinct hosts, every probe its
> own host, indexed); 35/35 browse-session unit tests pass. The
> collector IS usable for parallel collection at low concurrency. The
> higher-N ceiling is NOT yet characterized: start at conc=4-6 and
> raise only with the falsifier green at that N. The single in-thread
> serial loop also remains valid. Judgment still single in-thread.

`scripts/mcp-gate-parallel-collect.ts` is the parallel, NON-LLM collector
for the MCP release gate. It is the operational form of the rule above:
collection MAY be parallel and non-LLM; the VERDICT stays a single
in-thread agent reading raw artifacts vs `harness/probes/GATE_JUDGE.md`.

- One deterministic process, bounded worker pool. `UNBROWSE_GATE_CONCURRENCY`
  env (default 30) sizes the pool. Each probe runs the faithful
  resolve->go->snap->eval->close->resolve->execute sequence via the real
  `getInProcessApp` + `app.inject` path, writing the existing 8 artifact
  files. Resume-safe: a probe whose `execute.meta.json` exists is skipped.
- Endpoint pick is the deterministic top of score-sorted
  `available_endpoints` (structural rule, NOT a verdict). Params are
  derived from the probe URL querystring (structural primitive).
- It emits ZERO verdicts. `capture.meta.json.iso_self_check`
  (snap.current_url host vs intended host) is RAW isolation evidence at
  the chosen concurrency, judged in-thread, never a script PASS/FAIL.
- Empirical basis: concurrent sessions isolate cleanly at N<=6 (zero
  crosstalk), proven by `.bench-gate/parallel-go-falsifier.ts` and
  `.bench-gate/parallel-crosstalk-observe.ts` (real concurrent
  app.inject, no mocks). >6 is unverified; the per-probe iso_self_check
  is the in-run falsifier the agent reads. Full design + the Phase-1
  collapse finding: `docs/PARALLEL_SESSIONS_REBUILD.md`.
- Never let an LLM sub-agent collect or judge here: an LLM collector
  leaks judgment and is slower than the pool; a sub-agent verdict
  violates the harness/judge split. The gate SKILL.md was amended
  2026-05-17 to encode exactly this split.
## Page-artifact promotion for content-read intents (data-rich SSR pages)

When `rankEndpoints` evaluates a published skill that has BOTH a captured
page-artifact (doc_only synthetic with `dom_extraction`) AND XHR endpoints,
the default behavior is to demote the page-artifact when ANY URL in the
corpus looks API-shaped (`/api/`, `graphql`, `/rest/`, `/rpc/`, `voyager`).

This is wrong for content-read intents on data-rich SSR pages. Observed
on amazon.com/s, bing.com/search, and others: the published skill has 14+
endpoints; the ranker picks `patcConfig`-style telemetry XHR (whose URL
happens to look API-shaped) over the page-artifact that contains the
actual product/search listings as a high-confidence DOM extraction.

Rule: for `LIST_INTENT` (`search|list|find|trending|top|latest|discover|
browse`), when the page-artifact has `dom_extraction.confidence >= 0.8`
AND an array/object `response_schema`, promote it ABOVE structured-but-
noisy XHR. The page IS the data for these intents. Lives at
`src/execution/index.ts:rankEndpoints` next to PAGE_ARTIFACT_DEMOTION.

Anti-pattern this replaces: trusting URL shape (`/api/...`) as a proxy
for "this endpoint returns the data the user asked for". Many sites
expose tracking/config XHRs at API-looking paths; the response is rules,
flags, telemetry — not user-visible data.

If a future site requires the OPPOSITE preference (real XHR over page-
artifact even for LIST_INTENT), the agent should JUDGE from response
content via `unbrowse explain --top 5`, not bake another per-domain
heuristic.

## Decision-trace step naming convention

`executeEndpoint` and capture pipelines emit `decision_trace` arrays that the
calling agent reads to understand what happened. Step names should follow a
hierarchical underscore-separated convention so the agent can pattern-match
without parsing free-form English.

**Pattern**: `<scope>_<action_or_state>`, optionally extended with
`_<sub_state>` for fallback chains. Existing steps that conform:

- `probe` / `decision` — bare verbs (the always-present ladder steps)
- `server_fetch` / `browser` / `browser_default` / `browser_fallback` /
  `trigger_intercept` — `<strategy>_<action>` (probe-decision dispatches)
- `return_error` — `<scope>_<action>` (probe-gate short-circuit)
- `recipe_replay` — `<feature>_<action>`
- `auth_recovery_retry` — `<feature>_<action>` (the 401/403 retry)
- `5xx_ssr_fastpath_fallback` — `<status_class>_<feature>_<action>` (Phase D)
- `5xx_ssr_fastpath_fallback_success` / `_kuri_unavailable` /
  `_extract_empty` / `_no_html` / `_error` — extends parent with `_<state>`

**Reserved scope tokens**:
- Status classes: `5xx`, `4xx`, `401`, `403`, `400`, etc. (lead with the
  HTTP status that triggered the branch)
- Feature names: `auth_recovery`, `ssr_fastpath`, `page_fetch`,
  `vendor_block`, `bundle_replay`, `recipe_replay`
- Strategies: `server`, `browser`, `trigger_intercept`, `recipe_replay`,
  `return_error`

**Sub-state tokens** (for fallback chains that can succeed or fail in
multiple ways): `_success`, `_no_html`, `_extract_empty`, `_kuri_unavailable`,
`_error`, `_retry`, `_skipped`. Always emit a sub-state so the agent can
distinguish "the fallback ran and succeeded" from "the fallback ran and
the body was empty" from "the fallback ran and threw".

**When adding a new step**: pick the longest matching existing scope before
inventing one. If unsure, lead with the status class that triggered the
branch (e.g. `5xx_*` for any 5xx-handler); the agent already groups these.

**Anti-patterns** (do not introduce these):
- Mixed-case names: stick to lowercase + underscore
- Sentence-shaped step names: `step: "trying the auth recovery now"` — no
- Embedded data in the step name: put the data in sibling fields
  (`{ step: "server_fetch", status: 500 }`, not `step: "server_fetch_500"`)
- Localized words: stick to English; this is a machine-readable label

<!-- skills:pinned (managed by banger-skill-builder/pin_skill_in_agent_prompts.sh, do not hand-edit between markers) -->
## Pinned skills

Reach for these by name when the trigger phrase matches what the user asked for.

| Skill | Use when |
|---|---|
| `/unbrowse-bench-corpus-builder` | Add harder Unbrowse release-gate bench probes as typed corpus rows. |
| `/unbrowse-bench-history-tracker` | Append every agent-judged bench-gate run to a per-run history ledger and surface deltas in release notes. |
| `/web-app-harness` | scaffold a harness for this web app; set up the test loop; wire build test deploy debug fix |
| `/falsifier-gated-build` | verify this build honestly; is this regression mine or pre-existing; did I actually fix it or is it a painted lamp |
<!-- /skills:pinned -->


## Jesus-loop peer-collision guardrail (2026-05-18)

**Before multi-commit feature work on this repo — `/jesus-loop:take-the-wheel`, long `/loop` runs, anything >2 files or >50 LOC — run BOTH:**

```bash
gh pr list --state open --limit 30
gh pr list --state merged --limit 20 --search "in:title:claim OR DNS OR Privy OR owner OR splits OR fare OR economics OR domain"
```

If a peer codex loop has a matching open PR or a recently-merged commit, **abort**. Comment on the existing PR or rebase off it; don't ship a parallel implementation. Single-commit work (typo fix, version bump, one-file copy retune) skips the check.

Why + remediation in `project_fare_splits_jl_collision_20260518` memory. Linked: `peer-codex-loop`, `jesus-loop-shared-tree-peer-collision`, `jesus-loop-default-session-collision`.


<!-- meta-harness:autopin START -->
## meta-harness front door (autopinned; do not hand-edit between markers)

For any non-trivial plan in this project (ship a feature, fix a named bug,
build an agent or skill, redesign a UI, run a sustained convergence loop),
**you MUST route through meta-harness BEFORE freelancing or before
emitting any code/edit tool call**. This is binding agent behavior, not
a suggestion (Lewis 2026-05-20: "harness it so that i dont have to say
harness it"). The agent that ignores this rule and answers freelance is
in violation of the project contract.

REQUIRED first action on a plan-shaped prompt:

1. `bash ~/.claude/skills/meta-harness/scripts/harness discover` — surfaces
   every callable past harness in this project AND every global harness.
   If a past harness's plan_text matches the current request closely
   (agent judges similarity in-thread), `harness iterate <slug>` it
   instead of building new.
2. If no close match: `harness build "<plan>"`. Add `--global` when the
   harness is cross-project (integration with an external service,
   reusable tool surface, research loop).
3. The harness surfaces evidence; you judge in-thread. It never bakes a
   verdict, a banned list, or a per-case rule into the substrate.

EXEMPTIONS (the only cases where you may skip discover/build):

- A single scoped edit with no convergence shape (one-line typo fix,
  rename, comment).
- Pure analysis with no construction (answering a question, reading
  files, no writes / no deploys).

Everything else MUST go through harness. If you find yourself about to
freelance a multi-step task, STOP and run discover first. This block is
managed by `~/.claude/skills/meta-harness/scripts/autopin.py`; edit
there, not here.
<!-- meta-harness:autopin END -->
