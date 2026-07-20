# Contributing

Thanks for considering a contribution. Unbrowse is small, opinionated, and ships fast — read this once, then check `CLAUDE.md` for the engineering conventions that actually govern day-to-day work.

## Setup

```bash
git clone --recurse-submodules https://github.com/unbrowse-ai/unbrowse-dev.git
cd unbrowse-dev
bash scripts/ensure-submodules.sh   # initializes submodules/kuri (required for npm pack)
bun install
```

If you skip `ensure-submodules.sh` the pre-commit hook fails with "Broken Kuri source checkout" the first time you try to commit anything outside a merge.

## Running tests

| Command                              | What it covers                                                |
| ------------------------------------ | ------------------------------------------------------------- |
| `bun test`                           | Default smoke (path-params, utils, quality-gate)              |
| `bun test:all`                       | Full unit + backend test set                                  |
| `bun test:triage`                    | Per-test isolation harness (use this when ≥2 tests fail)      |
| `bun test:agent-xp`                  | Real agent-experience harness on the local CLI                |
| `bun --bun tsc --noEmit -p backend/tsconfig.json` | Backend typecheck                                |

Tests must hit real code paths. No mocks — see CLAUDE.md → "Testing".

## Code style

- Conventional commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`, `security:`, `docs:`.
- TypeScript strict; no `any` if you can help it.
- Comments: lead with the why, not the what. See CLAUDE.md.
- No `Co-Authored-By: Claude` / `Co-Authored-By: AI` trailers on commits in this repo.

## Pull requests

1. Branch off `main`. Keep PRs scoped — refactors and features in separate PRs.
2. Run `bun test` before pushing. CI runs `bun test:all` plus the agent-experience harness.
3. PR title starts with `v<VERSION>` if you're bumping (`/ship` does this for you). Otherwise descriptive.
4. Add a CHANGELOG.md `[Unreleased]` entry for anything user-visible.
5. Don't push directly to `main`. Don't force-push to it. Don't merge without CI green.

## Security disclosures

If you find a security issue, **do not file a public issue**. See [`SECURITY.md`](./SECURITY.md) for the disclosure process. The trust model and what the validator actually enforces are documented there too — read it before publishing skills with unusual fields.

## What lives where

- `src/` — shared skill engine (capture, reverse-engineer, execute). Runs on the user's machine.
- `backend/` — Cloudflare Worker API (marketplace, stats, x402, sponsor-pay). Hono + KV + Neon.
- `frontend/` — Next.js landing/dashboard.
- `packages/skill/` — isolated publishable skill package; `src/` is symlinked in.
- `submodules/kuri/` — vendored Zig browser binary source.

## More

The day-to-day rules — bench loop, codex eval harness, bug-fix protocol, ranker philosophy, GTM playbook — all live in [`CLAUDE.md`](./CLAUDE.md). Read that file when something feels arbitrary; it usually has the why.
