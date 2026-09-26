# Release

CI/CD publishes both packages from a tag. Nobody runs `npm publish` by hand.

1. Bump `version` in `packages/sdk/package.json` and `packages/cli/package.json` to the same value.
2. Merge to the default branch.
3. Push the tag: `git tag v12.0.0-alpha.1 && git push origin v12.0.0-alpha.1`.

The `release` workflow (`.github/workflows/release.yml`) then:

| Step | Fails the release when |
|---|---|
| `scripts/release-check.mjs` | the tag is not `vX.Y.Z[-pre]`, or either package has another version |
| typecheck, `bun test packages`, build | any error or failing test |
| pack, then `scripts/smoke-packed.sh` | the tarballs don't install and run on a clean Node, or the live public registry returns nothing |
| `npm publish --provenance` | `@unbrowse/sdk` first, then `unbrowse`; a version already on npm is skipped |
| dist-tag check | the published dist-tag does not point at the new version |
| GitHub release | — attaches both tarballs |

Versions with a pre-release suffix (`-alpha.1`) go to the `next` dist-tag; others to `latest`.
Re-run a tag from the Actions tab (`workflow_dispatch`, input `tag`).

Needs the repo secret `NPM_TOKEN` with publish rights to `unbrowse` and `@unbrowse/sdk`.

`ci.yml` runs typecheck, tests and build on every push and pull request.
