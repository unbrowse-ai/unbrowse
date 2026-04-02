# Deployment Guide

Read when: shipping a release, validating deployment config, or rotating Cloudflare/npm/skill-sync secrets.

## Production topology

Current production deploy split:

- backend: Cloudflare Worker from [backend/wrangler.toml](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/wrangler.toml)
- frontend: OpenNext-on-Cloudflare from [frontend/wrangler.jsonc](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/wrangler.jsonc)
- marketplace API origin: `https://beta-api.unbrowse.ai`
- web origin: `https://www.unbrowse.ai` and `https://unbrowse.ai`

## Canonical release path

Use the repo-root release flow:

```bash
bun run release
```

That is the only supported version-bump/tag path. It keeps:

- `package.json`
- `packages/skill/package.json`
- `version.json`

in sync before tagging and creating the GitHub release.

For polished user-facing notes, write `.release-notes.md` first. For announcement drafting, `bun run release:announce` reads the current release notes/changelog and emits the summary artifacts.

Detailed release choreography lives in [docs/RELEASING.md](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/RELEASING.md).

## Tag-triggered deploy pipeline

Pushing a `v*` tag runs `.github/workflows/release.yml`.

Current jobs:

1. publish CLI from `packages/skill/` to npm
2. deploy backend with `cd backend && bun run deploy`
3. deploy frontend with `cd frontend && bun run deploy`
4. sync the standalone skill repo

## Manual local deploy commands

Backend:

```bash
cd backend
bun install --frozen-lockfile
bun run dev
bun run deploy
```

Frontend:

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
bun run preview
bun run deploy
```

`frontend/package.json` currently uses `opennextjs-cloudflare build` for preview/deploy/upload.

## Required secrets

Release/deploy path currently expects:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NPM_TOKEN` or `NPM_PUBLISH_TOKEN`
- `SKILL_REPO_TOKEN`

Backend runtime secrets are documented in [backend/wrangler.toml](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/wrangler.toml):

- `API_KEY`
- `UNKEY_ROOT_KEY`
- `EMERGENTDB_API_KEY`
- `NEBIUS_API_KEY`

## Runtime config sources of truth

- backend routes, KV bindings, compatibility flags, staging env: [backend/wrangler.toml](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/wrangler.toml)
- frontend routes, assets, OpenNext worker entry: [frontend/wrangler.jsonc](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/wrangler.jsonc)
- frontend public API origin default: [frontend/.env.production](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/.env.production)
- runtime preset switching: [scripts/profile.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/scripts/profile.ts)

Prefer the preset system:

```bash
bun run preset:show
bun run preset:prod
bun run preset:testing
```

Do not hand-edit runtime env wiring for normal mode switches.
