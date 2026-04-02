# Releasing

Unbrowse releases are driven locally, then finished by GitHub Actions.

## Local release

0. Run `bun run release:announce` when you want a quick user-facing summary + X draft from the current release notes.
1. Write `.release-notes.md`.
2. Run `bun run release`.
3. `release-it` bumps:
   - `package.json`
   - `packages/skill/package.json`
   - `version.json`
4. `release-it` updates `CHANGELOG.md`, tags `vX.Y.Z`, pushes, and creates the GitHub Release.
5. During `after:bump`, release hooks also write `.release-announcement.md` and `.release-announcement.json` for announcement drafting.

Do not bump or publish only from `packages/skill/`.

- `packages/skill` can still build/package locally, but direct `npm publish` there is now guarded and fails with instructions.
- explicit local CLI publish path lives at repo root:
  - `bun run pack:cli`
  - `bun run publish:cli`
- local `bun run publish:cli` intentionally skips `--provenance`; provenance stays on the GitHub Actions release workflow, where npm supports automatic attestations.
- canonical path is still `bun run release`, which keeps `package.json`, `packages/skill/package.json`, and `version.json` in sync before the tag-triggered workflow publishes the CLI.
- `release-it` is configured with `npm.ignoreVersion=true` because `@release-it/bumper` already owns the version bump across all three files. That avoids the duplicate `npm version` pass that can otherwise fail with `Version not changed`.

## Main-branch GitHub Actions

Pushing to `main` runs `.github/workflows/release.yml`, which now:

1. Publishes the CLI from `packages/skill/` to npm if the current version is not already published.
2. Deploys the backend worker.
3. Deploys the frontend.
4. Syncs the external skill repo on `unbrowse-ai/unbrowse` `stable`.
5. Creates the matching tag + GitHub Release in `unbrowse-ai/unbrowse` if that version does not already exist.

Pushing `v*` tags still runs the same workflow, which remains safe for explicit release tags and reruns.

## Tag-triggered GitHub Actions

Tag pushes reuse `.github/workflows/release.yml`, which:

1. Publishes the CLI from `packages/skill/` to npm.
2. Deploys the backend worker.
3. Deploys the frontend.
4. Syncs the external skill repo.
5. Creates or reuses the matching tag + GitHub Release in `unbrowse-ai/unbrowse`.

The npm publish step is idempotent. If the tagged version is already on npm, the workflow skips publish instead of failing on reruns.

## Required secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NPM_TOKEN` or `NPM_PUBLISH_TOKEN`
- `SKILL_REPO_TOKEN`
- `DATABASE_URL`

Canonical releases on `unbrowse-ai/unbrowse` fail fast if the npm or skill-sync secrets are missing.

## CI checks before release

`test.yml` now runs on `main` pull requests and pushes, and verifies:

- `SKILL.md` is in sync with `src/cli.ts`
- `packages/skill` passes `npm pack --dry-run`
- the CLI/orchestrator path still passes `tests/cli-e2e.test.ts`

The CLI E2E job runs `bun run cli -- setup --no-start` first so CI verifies the vendored Kuri binary is discoverable before it exercises the CLI path.

Branch protection should require the workflow checks on `main` before merge.

That catches broken package layouts before a release tag is pushed.

`bun run release:announce` is the announcement view. It prefers `.release-notes.md`, falls back to the `## Unreleased` changelog section, and prints:

- top release highlights
- top fixes
- one short X-ready post draft

The release hook writes the same content to:

- `.release-announcement.md`
- `.release-announcement.json`

That hook already runs automatically inside `bun run release`.
