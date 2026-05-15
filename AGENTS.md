# AGENTS.md

## Project

Unbrowse — reverse-engineer any website into reusable API skills. Monorepo with bun workspaces.

## Structure

- `src/` — shared skill engine (capture, reverse-engineer, execute)
- `backend/` — Cloudflare Worker API (marketplace, stats)
- `frontend/` — Next.js landing page
- `packages/skill/` — publishable CLI package (directory name historical; published as `unbrowse` on npm; the Anthropic SKILL.md path retired in v6.15.0)
- `packages/sdk/` — `@unbrowse/sdk`, MIT TypeScript client that auto-spawns the CLI

## Conventions

- All notable changes must be written into `CHANGELOG.md`
- Use conventional commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`
- Skill sync retired in v6.15.0 — see CHANGELOG. The Anthropic skill repo path is no longer wired into the release flow.
- Durable agent memory lives in this file (`AGENTS.md`). Read it before substantial work.
- Keep `AGENTS.md` self-updating: when Lewis states a durable preference, recurring correction, decision, workflow, or project fact that will matter later, append a short bullet. Skip one-off noise.
- If a new lesson would have prevented repeated prompting, write it into `AGENTS.md` before handoff. (The older `docs/agent-memory.md` is archived at `docs/archive/agent-memory.md`; do not write to it.)
- When shipping new behavior, add or extend end-to-end coverage for that specific behavior on the real Unbrowse path; do not rely only on existing broad suites.
- Telemetry and analytics storage live in this repo's backend storage path (`statsKV` / `DATABASE_URL`), not a separate module or submodule.
- For external registry submissions, install docs, and public references, use `unbrowse-ai/unbrowse` — not `unbrowse-ai/unbrowse-dev`
- Optimize for two things first: accuracy of the chosen endpoint/task, then time to execute the right one. Prefer clean deferral over fast wrong execution.
- For slow Unbrowse task triage, inspect stored sessions first, then prefer proven structured JSON/API replay over browser capture. If replayed JSON keeps required top-level keys, treat byte-size drift as normal pagination/empty-result variance before escalating to trigger-intercept.
- Product-behavior evals/tests must go through the real CLI/orchestrator path (`src/cli.ts`, `resolveAndExecute`). Do not treat raw `captureSession()` or other low-level capture primitives as product-truth tests unless the test is explicitly for capture internals.
- For product claims, count only CLI/orchestrator runs through the canonical Codex harness (`bun run eval:codex`) that are reviewed in-thread by the agent, using the task-shaped product-success suite (`bun run eval:codex:product-success`) or equivalent real task URLs. Treat the stress suite (`bun run eval:codex:stress`) as breadth/regression signal only. The harness now also records graph/DAG selection and dependency-walk evidence in the same artifact, but those fixture-backed graph sections are still support signals, not product-truth by themselves.
- Use repo presets, not ad-hoc env edits, when switching runtime modes. Prefer `.env.runtime` via `bun run preset:prod` / `bun run preset:testing`.

## Releases

When asked to release, follow this flow:

1. Read commits since last tag: `git log $(git describe --tags --match='v*' --abbrev=0)..HEAD --format="%s"`
2. Read the diff of user-facing code (src/, packages/, README.md, packages/sdk/README.md)
3. Write polished, user-facing release notes to `.release-notes.md` (see format below)
4. Run `bun run release` — bumps version, updates CHANGELOG, tags, creates GitHub Release using the notes
5. The tag push triggers CI which deploys backend + frontend and publishes the `unbrowse` and `@unbrowse/sdk` packages to npm (skill-repo sync retired in v6.15.0)

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

## Auth Primitives — Autonomous Login

When `go` detects an auth wall, it returns `auth_required: true`. The resolve pipeline should auto-chain login primitives without manual intervention.

### CLI level (unbrowse primitives)
- `sessions-scan` — find which browsers have sessions for any domain
- `sessions-scan --domain <d>` — check a specific domain
- `go <url>` — auto-injects best browser cookies, returns `auth_required: true` if login still needed
- `snap --filter interactive` → `click` → `fill` → `submit` — drive any login UI

### Agent level (aiko chains primitives)
1. `go <url>` → detect `auth_required: true`
2. `sessions-scan --domain <d>` → check if any browser has session
3. If session found → inject cookies → reload → done
4. If no session → `snap` → find login button → `click`
5. If OAuth (Google/Facebook) → auto-completes via pre-injected OAuth cookies
6. If OTP → `fill` phone → read OTP from iMessage/TG → `fill` OTP → `submit`
7. `close` → session saved permanently, never login again

### Primitive levels
- **unbrowse CLI**: session scanning, cookie injection, auth detection, browse actions
- **aiko agent**: chaining primitives, reading OTP, making decisions about login strategy

## GitHub

- Base branch is always `main`
- Only create PRs and issues — do not push directly to `main`
- Protect `main` with required checks before merge. Minimum repo checks: `Repo Sanity`, `Unit Tests`, `Quality Gate`, `Backend Tests`, `Typecheck Backend`, `Package CLI`, `CLI E2E`.
- Secrets needed for releases: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SKILL_REPO_TOKEN`, `DATABASE_URL`

## Bench verdicts: harness collects, agent judges

When building benchmarks for unbrowse (or any reverse-engineer / call /
extract loop), DO NOT bake deterministic verdict heuristics into the
harness. The harness collects artifacts; the agent in-thread judges
whether the artifact satisfies the intent.

Anti-pattern (do not do this):
```python
if trace.success is True and status_code == 200:
    verdict = "PASS"
if "invalid_replay_params" in err:
    verdict = "REPAIR_REPLAY_PARAMS"
if text_bytes < 100 and "sparse_capture" in signals:
    verdict = "BROWSER_BLOCK"
```

`status_code == 200` does not mean the agent got useful data — could
be a captcha page, an empty array, the wrong shape. `invalid_replay_params`
might be a real fail, or the harness ran with insufficient inputs. Heuristic
verdicts mislead and bake category errors into every downstream report.

Right pattern:
1. Harness runs the loop and dumps RAW artifacts per URL: capture stdout,
   skill JSON, execute response body (full, not truncated), per-phase exit codes,
   captured_meta, browser_block_signals.
2. Harness emits a row of evidence (signals only) per URL — fields like
   `phase1_endpoints_discovered`, `phase2_status_code`, `phase2_response_bytes`,
   `phase2_response_excerpt`. NO verdict column the harness derived.
3. The agent (in-thread) reads each row's artifacts and judges:
   "did the agent actually get USB-C cable listings for `intent=search amazon
   for usb-c cables`?" — by reading the actual response body and matching
   against the intent's content expectation.
4. Heuristic groupings (BROWSER_BLOCK / VENDOR_BLOCKED) are a SORT-KEY for
   triage order, not a verdict. The verdict is the agent's in-thread judgment.

Reference skills: `unbrowse-dogfood` (canonical resolve+execute+verify
loop), `harness-makes-visible-agent-judges` (memory feedback in
`.claude/projects/...memory/`).

Two-phase bench (`scripts/bench-two-phase.sh`): collects per-URL
capture.out + execute.out + runs.jsonl rows. The `combined_verdict`
column is a sort-key only — agent judges by opening artifacts.

Regression tests can assert small invariants (e.g. an extractor returns a
field, a ranker orders two fixtures, a release hook runs), but they are not
coverage proof. Do not describe deterministic tests as bench verdicts or use
them to decide release coverage; only the agent-judged bench artifact verdict
does that.

<!-- skills:pinned (managed by banger-skill-builder/pin_skill_in_agent_prompts.sh, do not hand-edit between markers) -->
## Pinned skills

Reach for these by name when the trigger phrase matches what the user asked for.

| Skill | Use when |
|---|---|
| `/unbrowse-bench-corpus-builder` | Add harder Unbrowse release-gate bench probes as typed corpus rows. |
| `/unbrowse-bench-improvement-loop` | Run a self-improving Unbrowse bench loop. |
<!-- /skills:pinned -->
