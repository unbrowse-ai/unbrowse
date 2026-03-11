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

## Tag-triggered GitHub Actions

Pushing `v*` tags runs `.github/workflows/release.yml`, which now:

1. Publishes the CLI from `packages/skill/` to npm.
2. Deploys the backend worker.
3. Deploys the frontend.
4. Syncs the external skill repo.

The npm publish step is idempotent. If the tagged version is already on npm, the workflow skips publish instead of failing on reruns.

## Required secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NPM_TOKEN` or `NPM_PUBLISH_TOKEN`
- `SKILL_REPO_TOKEN`

Canonical releases on `unbrowse-ai/unbrowse` fail fast if the npm or skill-sync secrets are missing.

## CI checks before release

`test.yml` now verifies:

- `SKILL.md` is in sync with `src/cli.ts`
- `packages/skill` passes `npm pack --dry-run`

That catches broken package layouts before a release tag is pushed.

`bun run release:announce` is the announcement view. It prefers `.release-notes.md`, falls back to the `## Unreleased` changelog section, and prints:

- top release highlights
- top fixes
- one short X-ready post draft

The release hook writes the same content to:

- `.release-announcement.md`
- `.release-announcement.json`

That hook already runs automatically inside `bun run release`.
