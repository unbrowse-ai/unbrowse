# Deployment Guide

Read when: shipping a release, validating deployment config, or rotating Cloudflare/npm/skill-sync secrets.

## Production topology

Current production deploy split:

- backend: Cloudflare Worker from [backend/wrangler.toml](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/wrangler.toml)
- frontend: OpenNext-on-Cloudflare from [frontend/wrangler.jsonc](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/wrangler.jsonc)
- marketplace API origin: `https://beta-api.unbrowse.ai`
- web origin: `https://www.unbrowse.ai` and `https://unbrowse.ai`

Webhook/runtime extras:

- `POST /v1/webhooks/github` is the public GitHub webhook receiver for opt-in PR maintenance
- it dispatches the self-hosted `pr-agent.yml` workflow instead of blindly auto-merging PRs
- backend cron trigger runs every 6 hours UTC and flushes queued Telegram PR digests
- required webhook/notification secrets are documented below
- setup steps live in [docs/github-webhook-pr-bot.md](/Users/lekt9/.codex/worktrees/3c82/unbrowse/docs/github-webhook-pr-bot.md)

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

## Release workflow behavior

`.github/workflows/deploy.yml` handles `main`, `staging`, and `lewis/experiments` pushes.
`.github/workflows/release.yml` handles `v*` tag pushes.

Main deploy workflow:

1. deploy backend with `cd backend && bun run deploy:ci`
2. deploy frontend with `cd frontend && bun run deploy`
3. sync the standalone skill repo

Staging deploy workflow:

1. deploy backend with `cd backend && ./node_modules/.bin/wrangler deploy --config wrangler.ci.toml --env staging`
2. deploy frontend with `CLOUDFLARE_ENV=staging ./node_modules/.bin/opennextjs-cloudflare build && OPEN_NEXT_DEPLOY=true ./node_modules/.bin/wrangler deploy --env staging` so it publishes as `frontend-staging`
3. skip skill-repo sync and any release/publish side effects
4. if `PREVIEW_API_URL` is unset, skip the frontend staging deploy rather than pointing staging traffic at the wrong backend

Lewis experiments deploy workflow:

1. deploy backend with `cd backend && ./node_modules/.bin/wrangler deploy --config wrangler.ci.toml --env experiments`
2. deploy frontend with `CLOUDFLARE_ENV=experiments ./node_modules/.bin/opennextjs-cloudflare build && OPEN_NEXT_DEPLOY=true ./node_modules/.bin/wrangler deploy --env experiments` so it publishes as `frontend-experiments`
3. keep the surface on `workers.dev` only; no production or staging routes are touched
4. if `EXPERIMENTS_API_URL` is unset, skip the frontend experiments deploy rather than pointing the sandbox at the wrong backend

Tag release workflow:

1. publish CLI from `packages/skill/` to npm
2. upload GitHub release assets
3. deploy backend with `cd backend && bun run deploy:ci`
4. deploy frontend with `cd frontend && bun run deploy`
5. sync the standalone skill repo
6. create or update the downstream skill-repo release

## PR preview pipeline

Internal pull requests to `main` also run `.github/workflows/preview.yml`.

- frontend only; backend stays on the shared staging API
- preview uploads go to Cloudflare Preview URLs on `workers.dev`
- stable alias format: `pr-<number>`
- every new PR commit updates the same PR comment instead of creating a new one
- preview deploys are not part of required branch protection in v1

Current behavior:

- internal PRs: build the frontend with `NEXT_PUBLIC_API_URL=$PREVIEW_API_URL`, upload a new Worker version, and post both the stable alias URL and commit-specific preview URL back to the PR
- fork PRs: skip preview deploy entirely so Cloudflare secrets are never exposed to forked code, and post a skip note via the target-context comment job
- manual retry: use the `Preview` workflow's `workflow_dispatch` path with a PR number
Reruns are expected to be safe. The tag workflow is meant to complete cleanly when npm already has the version, and keep npm publish, frontend deploy, backend deploy, and skill sync aligned instead of partially failing on a replay.

## Manual local deploy commands

Backend:

```bash
cd backend
bun install --frozen-lockfile
bun run dev
bun run deploy
bun run deploy:ci
```

`bun run deploy:ci` uses `backend/wrangler.ci.toml` and preserves the existing
`STATS_KV` binding so GitHub Actions can deploy without requesting KV write
scope on every release run.

Frontend:

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
bun run preview
bun run deploy
```

`frontend/package.json` currently uses `opennextjs-cloudflare build` for preview/deploy/upload.

PR preview uploads use the same CLI family, but call `opennextjs-cloudflare upload --preview-alias pr-<number>` from GitHub Actions after an explicit `opennextjs-cloudflare build`.

## Required secrets

Release/deploy path currently expects:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NPM_TOKEN` or `NPM_PUBLISH_TOKEN`
- `SKILL_REPO_TOKEN`

Preview deploys also expect one of:

- repo variable `PREVIEW_API_URL`
- or repo secret `PREVIEW_API_URL`

That value should point at the shared staging backend origin used by preview builds and `staging` branch frontend deploys. Do not hardcode the staging hostname into source files.

Lewis experiments branch deploys also expect one of:

- repo variable `EXPERIMENTS_API_URL`
- or repo secret `EXPERIMENTS_API_URL`

That value should point at the backend origin for the `experiments` worker deploy. Keep it separate from `PREVIEW_API_URL` so the sandbox branch can drift safely without changing staging previews.

Backend runtime secrets are documented in [backend/wrangler.toml](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/wrangler.toml):

- `API_KEY`
- `UNKEY_ROOT_KEY`
- `EMERGENTDB_API_KEY`
- `NEBIUS_API_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_PR_BOT_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Runtime config sources of truth

- backend routes, KV bindings, compatibility flags, staging env: [backend/wrangler.toml](/Users/lekt9/.codex/worktrees/c99f/unbrowse/backend/wrangler.toml)
- frontend routes, assets, OpenNext worker entry: [frontend/wrangler.jsonc](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/wrangler.jsonc)
- frontend public API origin default: [frontend/.env.production](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/.env.production)
- runtime preset switching: [scripts/profile.ts](/Users/lekt9/.codex/worktrees/c99f/unbrowse/scripts/profile.ts)
- PR preview workflow: [.github/workflows/preview.yml](/Users/lekt9/.codex/worktrees/20aa/unbrowse/.github/workflows/preview.yml)

Prefer the preset system:

```bash
bun run preset:show
bun run preset:prod
bun run preset:testing
bun run preset:experiments
```

Do not hand-edit runtime env wiring for normal mode switches.
