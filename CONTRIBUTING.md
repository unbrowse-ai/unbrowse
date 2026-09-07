# Contributing

Thanks for considering a contribution. Unbrowse is small, opinionated, and ships fast — read this once, then check `docs/` for the architecture behind the code.

## Setup

```bash
git clone --recurse-submodules https://github.com/unbrowse-ai/unbrowse.git
cd unbrowse
bash scripts/ensure-submodules.sh   # initializes submodules/kuri (required for npm pack)
bun install
```

If you skip `ensure-submodules.sh` the pre-commit hook fails the first time you try to commit anything outside a merge.

## Running tests

| Command                              | What it covers                                                |
| ------------------------------------ | ------------------------------------------------------------- |
| `bun test`                           | Default smoke (path-params, utils, quality-gate)              |
| `bun test:all`                       | Full unit + backend test set                                  |
| `bun test:triage`                    | Per-test isolation harness (use this when ≥2 tests fail)      |
| `bun --bun tsc --noEmit -p backend/tsconfig.json` | Backend typecheck                                |

Tests must hit real code paths. No mocks.

## Code style

- Conventional commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`, `security:`, `docs:`.
- TypeScript strict mode; no `any` in new code.
- Comments lead with the why, not the what.

## Pull requests

1. Fork, branch, make the change.
2. `bun run check:version-consistency` and the affected tests must pass.
3. Open a PR against `main`. CI runs the unit, quality-gate, and backend suites.
4. One logical change per PR. If you found a bug and a fix, ship the repro test first.

## Security

Do not open public issues for security problems. See [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License that covers this project.
