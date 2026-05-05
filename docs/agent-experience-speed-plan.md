---
read_when:
  - changing CLI, MCP, resolve, execute, fetch, browse, capture, publish, skill export, or agent-experience harness behavior
  - deciding whether to add a new agent-facing command, tool, primitive, endpoint, or workflow abstraction
  - investigating slow resolve, browser fallback, stale skill, empty execute, or public primitive behavior
---

# Agent Experience and Speed Plan

Date: 2026-05-05

Owner: Lewis

## Decision

Unbrowse should not become a bigger agent framework. It should become the fastest
agent-facing browser/data substrate:

1. Give agents a complete enough action space to finish real web work.
2. Learn reusable primitives from that work.
3. Make future agents avoid repeating browser work.
4. Keep the CLI as a first-class product surface, with MCP and skills mirroring
   the same contracts instead of inventing separate behavior.

The product line is:

> Agents can do anything in the browser, but Unbrowse makes them avoid doing it
> twice.

## North Star

Minimize unnecessary browser opens without hiding browser truth.

Primary metrics:

- Browser-open rate per task.
- Resolve p50/p95 latency by source: local cache, local artifact, marketplace,
  live browser.
- Execute success rate after resolve.
- Timed-out task count.
- Confidence sanity: obvious matches must not report zero confidence.
- Stale-skill rate: cached skills returned after recent execute failures.
- Agent loop count: repeated same-host resolve misses in one task.

Target behavior:

- Local exact skill/artifact hit: <= 200 ms p50.
- Local domain/intent shortlist: <= 500 ms p50.
- Marketplace metadata shortlist: <= 1000 ms p50, deadline bounded.
- Browser fallback: explicit, recoverable, and capture-producing.
- No silent browser side effects from default resolve.

## Surfaces

### CLI Is Canonical

Every product behavior must be available through `unbrowse` first. MCP tools,
generated `SKILL.md`, and SDK helpers should wrap the same runtime contracts.

Canonical CLI surface:

- `unbrowse fetch <url>` - direct URL to useful content/artifacts/primitives.
- `unbrowse resolve <intent> [--url <url>]` - non-browser shortlist by default.
- `unbrowse execute <primitive|endpoint>` - explicit replay.
- `unbrowse go <url>` - browser session when browsing is required.
- `unbrowse eval <expr>` - raw browser escape hatch.
- `unbrowse sync` / `unbrowse close` - compile observed work into primitives.
- `unbrowse skill` / `unbrowse publish` / `unbrowse review` - inspect and share.
- `unbrowse agent-xp` or existing harness scripts - measure agent experience.

CLI requirements:

- Same JSON schema as MCP for resolve, execute, fetch, errors, primitives, and
  next actions.
- Human help text and `--json` output must agree.
- Every failure returns `code`, `message`, `recoverable`, `next_actions`, and
  `suggested_commands`.
- Commands should never imply a single brittle command can solve every site.
  Probe fast, then escalate explicitly.
- Defaults must be safe: resolve does not browse unless a flag says it can.

### MCP Is Thin

MCP should be a host integration layer, not a second product.

Primary MCP tools should map to the canonical surface:

- `unbrowse_fetch`
- `unbrowse_resolve`
- `unbrowse_execute`
- `unbrowse_go`
- `unbrowse_eval`
- `unbrowse_sync`
- `unbrowse_close`
- `unbrowse_skill`
- `unbrowse_publish`
- `unbrowse_review`

Granular browser helpers like click/fill/type/scroll can stay, but they should
be secondary conveniences. Agents should be guided toward raw `eval` and
state/resource handles when the task needs browser freedom.

### Skills Are Generated Guidance

Generated skills should describe:

- The same CLI-first flow.
- Fast path, fallback path, and publish path.
- Public primitive semantics.
- Auth and privacy boundaries.
- What to do on resolve miss.

Skills should not contain stale hand-written command mazes that drift from the
CLI.

## Primitive Model

All reusable work should share one primitive surface. API endpoints are only one
primitive type.

Primitive types:

- `api_request` - replayable HTTP/GraphQL/RPC request.
- `browser_workflow` - repeatable browser steps with captured evidence.
- `content_artifact` - HTML, JSON, RSC payload, markdown, PDF, document,
  transcript, image, screenshot, media manifest, or saved source file.
- `resource_recipe` - instructions to refresh/read/download a gated or dynamic
  resource.
- `file_download` - stable downloadable object with metadata and content hash.
- `auth_context` - required cookies/session/OAuth state, represented as a
  requirement, not published secret material.

Required primitive fields:

- `id`
- `type`
- `title`
- `description`
- `source_url`
- `source_domain`
- `created_at`
- `freshness`
- `auth_required`
- `input_schema`
- `output_schema`
- `replay_method`
- `cost`
- `confidence`
- `evidence`
- `public_policy`
- `local_artifacts`
- `public_artifacts`
- `next_actions`

Public primitive rule:

- Public-safe data can publish as content-addressed artifact URLs.
- Private, gated, or user-specific data publishes as a recipe/locator only.
- Local file paths never appear in public marketplace output.
- Secrets, cookies, tokens, request headers, and private response bodies are
  never published.

## Hot Paths

### Fetch

`fetch` is the fastest answer for URL-shaped tasks.

Flow:

1. Fetch static body and response headers.
2. Detect type: HTML, JSON, RSC/Flight, PDF, document, media, binary, text.
3. Extract useful data and artifact handles.
4. Compile reusable content primitives.
5. Publish only public-safe metadata unless explicitly reviewed.
6. Return a compact answer plus saved artifacts.

Acceptance:

- Useful output for SSR HTML, Next/RSC payloads, JSON APIs, PDFs, and text.
- `--raw`, `--markdown`, `--path`, `--extract`, `--limit`, and `--save` work
  without shell pipelines.
- Large outputs return handles by default.

### Resolve

`resolve` is the single public selection primitive. By default it must not open
a browser.

Flow:

1. Exact local URL/primitive cache.
2. Local domain manifest and artifact index.
3. Session memoized previous resolve result.
4. Local semantic/BM25 shortlist.
5. Marketplace metadata shortlist with a hard deadline.
6. Optional live handoff only when the caller requests it.

Acceptance:

- Same-host miss returns a handoff stub instead of repeated empty resolves.
- Candidates include confidence, reason, freshness, health, source, latency, and
  missing bindings.
- Marketplace can return a skinny shortlist without hydrating full skills.
- No stale skill ranks above a recently successful fresh candidate.

### Execute

`execute` should either return useful data or tell the agent exactly why it did
not.

Failure reasons:

- `auth_required`
- `extraction_empty`
- `endpoint_dead`
- `wrong_param`
- `schema_drift`
- `rate_limited`
- `browser_blocked`
- `stale_skill`
- `network_error`
- `unsupported_primitive`

Acceptance:

- Empty extract with non-empty raw body auto-falls back or reports
  `extraction_empty` with raw artifact handle.
- 401/403 attempts credential refresh from local browser/session store before
  giving up.
- Response sanity checks validate important user-supplied params when possible.
- Every execute outcome updates health/freshness signals.

### Browser

Browser is truth for new workflows. It should be powerful and explicit.

Flow:

1. `go` starts or attaches to a browser session.
2. `eval` provides raw browser control for agents that can reason.
3. `snap/click/fill/type/scroll` remain helper sugar.
4. Passive capture records HAR, JS interceptor, SSR payloads, DOM artifacts, and
   resources.
5. `sync`/`close` compiles the session into primitives.

Acceptance:

- Kuri cold start is paid before the first real browse command when possible.
- Recoverable browser startup errors surface retry guidance.
- Session close flushes all interceptor data.
- `go` does not silently swap tabs or recover into a different session without
  telling the caller.

## Speed Workstreams

### 1. Confidence and Ranking

Problem:

- Current marketplace confidence can round obvious matches to `0`, which makes
  agents distrust good candidates and open browsers.

Plan:

- Normalize confidence to `0..1` from evidence, not raw backend score scale.
- Include score margin between top candidate and runner-up.
- Boost exact host/path/query binding matches.
- Penalize stale, recently failed, unauthenticated, schema-drifted, and generic
  auto-generated descriptions.
- Emit `confidence_reason[]` in CLI/MCP.

Acceptance:

- Obvious exact URL/domain matches never return zero confidence.
- Ambiguous candidates explain why confidence is low.
- Harness has confidence sanity assertions.

### 2. Local-First Shortlist

Problem:

- Marketplace-backed resolves are too slow for agent loops.

Plan:

- Build a local skinny index for skill metadata, primitive metadata, artifact
  metadata, health, freshness, and recent intents.
- Use local index before network.
- Cache same-session resolve results and misses.
- Return partial results when marketplace misses the deadline.

Acceptance:

- Local hit avoids backend network.
- Repeated same-host miss returns immediately with the earlier handoff stub.
- Resolve response includes per-source timings.

### 3. Marketplace Lazy Hydration

Problem:

- Resolve should not fetch and parse large skill manifests before it knows which
  candidate matters.

Plan:

- Backend returns skinny candidate records first.
- Full skill hydration happens only for top candidates or execute.
- CLI/MCP output uses candidate IDs and lazy details.

Acceptance:

- Marketplace shortlist can complete inside deadline.
- Execute still has full replay contract before sending a request.

### 4. Artifact Handles Instead of Context Dumps

Problem:

- Large DOM snapshots, HTML bodies, PDFs, RSC chunks, and markdown dumps bloat
  agent context.

Plan:

- Store large outputs locally under a stable artifact/resource directory.
- Return digest, type, size, summary, path, and read commands.
- MCP returns handles by default; CLI offers `--raw`/`--print` for humans.
- Public publish replaces local paths with blob URLs or recipes.

Acceptance:

- MCP tool results stay compact.
- CLI can still print full raw output when explicitly requested.
- Public primitive output never contains private local paths.

### 5. Browser Warmup and Attach

Problem:

- Browser fallback is expensive, and agents may already be using a browser we
  could observe.

Plan:

- Warm Kuri on daemon/server startup.
- Add or refine `attach` to connect to existing Chrome/CDP-compatible sessions.
- Observe any browser session driven by Claude, Dia, Chrome, or another agent
  when authorized.
- Capture network/resource evidence without forcing agents through wrappers.

Acceptance:

- First browse command avoids avoidable cold-start timeout.
- Attached session can produce the same primitive compilation output as `go`.
- Capture proves useful even when the agent used raw browser/CDP actions.

## Agent UX Workstreams

### 1. CLI Guidance Enforcement

Plan:

- Keep fast-path guidance in `unbrowse help`, command errors, and generated
  skills.
- Add next-action blocks to `fetch`, `resolve`, `execute`, `go`, `eval`,
  `sync`, `close`, `skill`, `publish`, and `review`.
- Make `--json` output machine-actionable and stable.
- Avoid telling agents to use shell pipes for JSON processing.

Acceptance:

- A CLI-only agent can complete fetch, resolve/execute, and browse/publish
  loops without reading MCP docs.
- `check:skill-md` verifies generated docs match CLI guidance.

### 2. Resolve Miss Handoff

Plan:

- Return typed options on miss:
  - `browse_only`
  - `capture_for_reuse`
  - `auth_then_retry`
  - `try_fetch`
  - `abandon_or_report`
- Include suggested commands for CLI and MCP.
- Include why browser is or is not recommended.

Acceptance:

- No empty `available_operations` response without next actions.
- Same-host repeated miss is suppressed.

### 3. Review/Publish as the Reuse Gate

Plan:

- Fresh browser captures become local primitives first.
- Shared/public publish requires review of privacy, description, replay
  contract, and artifact policy.
- CLI and MCP expose the same review/publish sequence.

Acceptance:

- Background sync cannot leak unreviewed private primitives.
- Agents can inspect and publish from CLI without hidden manual steps.

## Public Generalization

Public usability requires separating reusable method from private data.

Publish classes:

- `public_artifact` - safe static artifact body can be shared.
- `public_recipe` - method is shareable, body is not.
- `private_local` - stays local only.
- `review_required` - blocked until human/agent review.

Public marketplace output should include:

- Primitive metadata.
- Replay method or refresh recipe.
- Input/output schema.
- Freshness/health.
- Evidence summary.
- Public artifact URL if safe.
- Auth requirement if needed.

It should not include:

- Cookies.
- Authorization headers.
- User-specific private response bodies.
- Local file paths.
- Unreviewed auto-generated descriptions presented as truth.

## Codebase Plan

Do not start with a repo-wide refactor. Fix product behavior first and extract
small modules as files are touched.

Freeze rule:

- New ranking logic should not be added directly to `src/orchestrator/index.ts`.
- New execute logic should not be added directly to `src/execution/index.ts`.
- New CLI/MCP schemas should live in shared types/helpers.

Extraction targets:

- `src/orchestrator/confidence.ts`
- `src/orchestrator/resolve-shortlist.ts`
- `src/orchestrator/resolve-cache.ts`
- `src/execution/failure-reasons.ts`
- `src/execution/response-sanity.ts`
- `src/artifacts/index.ts`
- `src/primitives/index.ts`
- `src/browser/raw-actions.ts`
- `src/cli/output-contracts.ts`
- `src/mcp/tool-contracts.ts`

Adapters:

- CLI adapter: parse args, call shared runtime, render JSON/human output.
- MCP adapter: validate input, call shared runtime, return compact tool result.
- Skill adapter: render generated docs from shared command/primitive metadata.

## Implementation Phases

### Phase 0 - Baseline and Planning

Status: current plan.

Tasks:

- Record plan in docs.
- Record CLI-first durable preference.
- Preserve current dirty worktree; do not revert unrelated generated files.
- Re-run agent-experience harness before major behavior changes.

Exit:

- Plan is committed or linked from issues.

### Phase 1 - Fast Correctness Fixes

Tasks:

- Fix confidence normalization.
- Add confidence sanity tests.
- Add resolve timing fields to responses where missing.
- Add repeated same-host miss memoization if not already present.
- Fix obvious duplicate/import drift discovered during review.

CLI support:

- `unbrowse resolve --json` shows confidence and confidence reasons.
- Human output labels low-confidence candidates clearly.

Verification:

- Targeted resolve tests.
- `bun run agent-xp` or focused harness subset.
- `bun run check:skill-md`.

### Phase 2 - Primitive Contract Finish

Tasks:

- Finalize one primitive schema across endpoint, workflow, artifact, and recipe.
- Ensure local artifact sidecars are represented as primitives.
- Ensure public publish emits public-safe primitive views.
- Add content-addressed artifact/public recipe policy hooks.

CLI support:

- `unbrowse fetch --json` returns primitives.
- `unbrowse skill --json` and `unbrowse publish --dry-run --json` show the same
  primitive view.

Verification:

- Workflow artifact tests.
- Publish export tests.
- Backend typecheck.

### Phase 3 - CLI/MCP Contract Alignment

Tasks:

- Define shared output contracts for fetch, resolve, execute, browser, review,
  publish, and errors.
- Update MCP tools to mirror CLI outputs.
- Relegate granular browser helpers to secondary docs.
- Add compact resource-handle outputs for large MCP/browser state results.

CLI support:

- `unbrowse help` and generated skills describe the same primary path.
- All commands support stable `--json`.

Verification:

- MCP stdio tests.
- CLI e2e tests.
- Skill docs sync test.

### Phase 4 - Resolve Speed Path

Tasks:

- Add local skinny index for primitives/artifacts/skills.
- Make resolve race local cache, local artifact, local semantic shortlist, and
  marketplace metadata with deadlines.
- Lazy hydrate marketplace skills only when selected.
- Return partial candidates with timeout diagnostics.

CLI support:

- `unbrowse resolve --timings --json` shows source timings.
- `unbrowse resolve --no-network` proves local-only behavior.

Verification:

- Agent-experience harness latency budgets.
- Unit tests for local hit, marketplace timeout, and same-host repeated miss.

### Phase 5 - Browser Power and Passive Learning

Tasks:

- Keep `eval` as the raw browser escape hatch.
- Add a CDP/raw action command if Kuri exposes a stable enough surface.
- Warm browser runtime before first command.
- Add attach-to-existing-browser flow where feasible.
- Ensure passive capture works for raw browser actions.

CLI support:

- `unbrowse go`, `unbrowse eval`, `unbrowse attach`, `unbrowse sync`, and
  `unbrowse close` form the complete browser loop.

Verification:

- Browser e2e capture test.
- Capture produces primitives after raw `eval` action.
- Warm start regression check.

### Phase 6 - Telemetry and Release Gate

Tasks:

- Emit canonical lifecycle events:
  - `task_start`
  - `resolve_start`
  - `resolve_end`
  - `execute_start`
  - `execute_end`
  - `browser_opened`
  - `capture_synced`
  - `publish_reviewed`
  - `task_end`
- Aggregate browser-open rate, latency, source, confidence, and outcome.
- Add release/harness budget checks.

CLI support:

- `unbrowse agent-xp --json` or existing harness scripts produce budget output.

Verification:

- Harness fails on confidence-zero obvious matches.
- Harness fails on unexpected browser open for cache-hit tasks.
- Harness records CLI and MCP paths consistently.

### Phase 7 - File Boundary Cleanup

Tasks:

- Move confidence/ranking logic into smaller modules.
- Move primitive/artifact logic into smaller modules.
- Move CLI rendering contracts out of the main CLI file.
- Move MCP tool contract definitions away from implementation details.

Verification:

- No behavior-only refactor without tests.
- No broad search/replace.
- Existing gates remain green.

## PR Slices

Recommended PR order:

1. `fix(resolve): normalize confidence and expose reasons`
2. `test(agent-xp): add speed and confidence budgets`
3. `feat(cli): stabilize primitive/error JSON contracts`
4. `feat(primitives): publish artifact and recipe primitives safely`
5. `feat(mcp): align primary tools with CLI contracts`
6. `perf(resolve): local-first shortlist with marketplace deadline`
7. `feat(browser): warm runtime and capture raw eval sessions`
8. `feat(browser): attach existing CDP session for passive capture`
9. `refactor(resolve): extract ranking and confidence modules`

## Acceptance Gates

Before handoff for each PR:

- Relevant unit tests.
- Relevant CLI e2e or harness subset.
- `bun run check:skill-md` when CLI/help/skill docs change.
- Backend typecheck when public marketplace/backend types change.
- Agent-experience metric comparison when resolve/browser behavior changes.
- Changelog entry for notable behavior/docs changes.

Before release:

- Full gate or documented blockers.
- Agent-experience harness reviewed in-thread.
- Browser-open rate and resolve latency compared to previous run.
- Public primitive output inspected for privacy leaks.
- Generated skills synced.

## Non-Goals

- Do not build a separate high-level agent framework.
- Do not hide browser traversal behind implicit API replay.
- Do not add per-domain special cases to the generic ranker.
- Do not make MCP behavior diverge from CLI behavior.
- Do not publish private artifacts to the shared marketplace.
- Do not refactor giant files for cleanliness before product gates improve.

## Open Questions

- Public artifact store: backend R2/blob store vs existing marketplace storage.
- Raw CDP command shape: expose Kuri CDP directly or a narrower JSON command.
- Attach support: which browsers/profiles are safe to support first.
- Hosted agent loop: whether Unbrowse ever owns an explicit `done` tool, or
  leaves that to agent hosts.
- Latency budgets: exact p50/p95 thresholds after a fresh baseline run.

