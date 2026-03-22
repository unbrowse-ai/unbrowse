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
   - framework package manifests in `integrations/`
4. `release-it` updates `CHANGELOG.md`, tags `vX.Y.Z`, pushes, and creates the GitHub Release.
5. During `after:bump`, release hooks also write `.release-announcement.md` and `.release-announcement.json` for announcement drafting.

Do not bump or publish only from `packages/skill/`.

- `packages/skill` can still build/package locally, but direct `npm publish` there is now guarded and fails with instructions.
- explicit local CLI publish path lives at repo root:
  - `bun run pack:cli`
  - `bun run publish:cli`
- local `bun run publish:cli` intentionally skips `--provenance`; the GitHub Actions release workflow also skips provenance on this self-hosted runner pool because npm rejects attestations outside supported hosted environments.
- canonical path is still `bun run release`, which keeps `package.json`, `packages/skill/package.json`, and `version.json` in sync before the tag-triggered workflow publishes the CLI.
- `release-it` is configured with `npm.ignoreVersion=true` because `@release-it/bumper` already owns the version bump across all three files. That avoids the duplicate `npm version` pass that can otherwise fail with `Version not changed`.

## Tag-triggered GitHub Actions

Pushing `v*` tags runs `.github/workflows/release.yml`, which now:

1. Mirrors `unbrowse-dev` `main` plus the release tag into the public `unbrowse-ai/unbrowse` repo.
2. Publishes the CLI from `packages/skill/` to npm.
3. Publishes npm framework packages from `integrations/`, including OpenClaw.
4. Publishes Python framework packages from `integrations/` to PyPI.
5. Deploys the backend worker.
6. Deploys the frontend.

The npm publish step is idempotent. If the tagged version is already on npm, the workflow skips publish instead of failing on reruns.
The PyPI publish steps are also idempotent and skip when the tagged version is already live.

## Manual release dry-run

Need a branch-safe rehearsal before cutting a tag:

1. Push your branch.
2. Run the `Release` workflow manually against that branch (`workflow_dispatch`, mode `dry-run`).
3. Wait for:
   - `Test Gate`
   - `Package CLI (Dry Run)`
   - `Package Frameworks (npm Dry Run)`
   - `Package Frameworks (PyPI Dry Run)`

Dry-run mode never deploys staging or production and never publishes to npm or PyPI. It only runs the release test gate plus the same package/build steps the tag workflow would use right before publish.

## Local packaging rehearsal

Need the CI/package path locally before you tag or push:

```bash
bun run release:local
```

That script:

- syncs the Kuri submodule and installs root deps
- checks `SKILL.md` sync
- builds the CLI tarball from `packages/skill`
- installs that tarball into a fresh temp project and runs `npx unbrowse --help`
- runs npm package dry-runs for `integrations/elizaos`, `integrations/mcp`, and `integrations/openclaw`
- runs OpenClaw typecheck/tests before its pack dry-run
- builds the Python integration artifacts in disposable virtualenvs
- runs backend typecheck and frontend production build

It keeps the CLI tarball, smoke-install sandbox, and Python build copies in `/tmp`, and uses temp virtualenvs for Python package builds so local macOS `python3` setups with PEP 668 do not block the rehearsal.

## Required secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NPM_TOKEN` or `NPM_PUBLISH_TOKEN`
- `PYPI_API_TOKEN`
- `PUBLIC_REPO_TOKEN`

Canonical releases on `unbrowse-ai/unbrowse` fail fast if the npm or skill-sync secrets are missing.

## CI checks before release

`test.yml` now verifies:

- `SKILL.md` is in sync with `src/cli.ts`
- `packages/skill` passes `npm pack --dry-run`
- integration package versions match the root release version
- npm integration packages pass `npm pack --dry-run`
- Python integration packages build sdists/wheels cleanly
- after all green checks on `main`, GitHub Actions force-syncs `unbrowse-dev` `main` into the public `unbrowse-ai/unbrowse` repo

That catches broken package layouts before a release tag is pushed.

`bun run release:announce` is the announcement view. It prefers `.release-notes.md`, falls back to the `## Unreleased` changelog section, and prints:

- top release highlights
- top fixes
- one short X-ready post draft

The release hook writes the same content to:

- `.release-announcement.md`
- `.release-announcement.json`

That hook already runs automatically inside `bun run release`.
