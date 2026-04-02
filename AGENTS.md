# AGENTS.md

## Project

Unbrowse — reverse-engineer any website into reusable API skills. Monorepo with bun workspaces.

## Structure

- `src/` — shared skill engine (capture, reverse-engineer, execute)
- `backend/` — Cloudflare Worker API (marketplace, stats)
- `frontend/` — Next.js landing page
- `packages/skill/` — isolated publishable skill package (src/ symlinks to root)

## Conventions

- All notable changes must be written into `CHANGELOG.md`
- Use conventional commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`
- Use `bash scripts/sync-skill.sh` to publish skill changes to `unbrowse-ai/unbrowse`
- Optimize for two things first: accuracy of the chosen endpoint/task, then time to execute the right one. Prefer clean deferral over fast wrong execution.
- Product-behavior evals/tests must go through the real CLI/orchestrator path (`src/cli.ts`, `resolveAndExecute`). Do not treat raw `captureSession()` or other low-level capture primitives as product-truth tests unless the test is explicitly for capture internals.
- For product claims, count only CLI/orchestrator runs through the canonical Codex harness (`bun run eval:codex`) that are reviewed in-thread by the agent, using the task-shaped product-success suite (`bun run eval:codex:product-success`) or equivalent real task URLs. Treat the stress suite (`bun run eval:codex:stress`) as breadth/regression signal only. The harness now also records graph/DAG selection and dependency-walk evidence in the same artifact, but those fixture-backed graph sections are still support signals, not product-truth by themselves.
- Use repo presets, not ad-hoc env edits, when switching runtime modes. Prefer `.env.runtime` via `bun run preset:prod` / `bun run preset:testing`.

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

- Base branch is always `rach/restart-base`
- Only create PRs and issues — do not push directly to `rach/restart-base`
- Protect `rach/restart-base` with required checks before merge. Minimum repo checks: `Repo Sanity`, `Unit Tests`, `Quality Gate`, `Backend Tests`, `Typecheck Backend`, `Package CLI`, `CLI E2E`.
- Secrets needed for releases: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SKILL_REPO_TOKEN`, `DATABASE_URL`
