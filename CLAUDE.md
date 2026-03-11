# CLAUDE.md

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
