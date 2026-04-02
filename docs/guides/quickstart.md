# Quickstart

Read when: first local install, first CLI run, or CI/headless setup.

Canonical reader docs live at [docs.unbrowse.ai](https://docs.unbrowse.ai). The repo-level agent contract lives in [SKILL.md](/Users/lekt9/.codex/worktrees/c99f/unbrowse/SKILL.md).

## Fast path

```bash
npx unbrowse setup
```

`unbrowse setup` is the canonical bootstrap path. In the current repo it does four things:

1. checks the local package-manager/runtime environment
2. verifies the bundled Kuri browser runtime, or builds it from vendored source when working from repo checkout with Zig available
3. installs or updates the Open Code `/unbrowse` command when Open Code is detected
4. starts the local server on `http://localhost:6969` unless `--no-start` is passed

For repeat use:

```bash
npm install -g unbrowse
unbrowse setup
```

If your host uses skills:

```bash
npx skills add unbrowse-ai/unbrowse
```

## First-run behavior

The CLI auto-starts the local server for normal commands. On the first real startup it also handles agent registration.

- If the backend is reachable, it checks the current ToS version.
- Interactive runs prompt for ToS acceptance.
- Interactive runs also let you enter an email-style agent identity. Press Enter to keep the local device id.
- Headless runs can preseed identity with `UNBROWSE_AGENT_EMAIL`.
- Non-interactive runs must set `UNBROWSE_TOS_ACCEPTED=1` after the user has agreed to the ToS.

Useful env vars for CI/headless runs:

```bash
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1
export UNBROWSE_AGENT_EMAIL=agent@example.com
```

## First commands

Health check:

```bash
unbrowse health --pretty
```

Resolve a task against a URL:

```bash
unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty
```

Search the marketplace without opening a browser:

```bash
unbrowse search --intent "get stock prices" --domain "finance.yahoo.com" --pretty
```

Open an auth flow when a site needs login:

```bash
unbrowse login --url "https://calendar.google.com"
```

## Working from repo checkout

Initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

That pulls the tracked Kuri source into `submodules/kuri`. Packaging from the monorepo bundles the platform-specific Kuri binaries from that source.

Repo presets are the supported runtime switch:

```bash
bun run preset:show
bun run preset:prod
bun run preset:testing
```

Do not hand-edit ad hoc runtime env files unless you are intentionally changing the preset system.

## Local state

Important runtime paths:

- `~/.unbrowse/config.json` — saved API key, agent id, ToS acceptance
- `~/.unbrowse/logs/` — daily logs
- `~/.unbrowse/profiles/<domain>/` — headed login/browser profile state
- `~/.unbrowse/skill-snapshots/` — cached local skill manifests
- `~/.unbrowse/route-cache.json` — intent+URL route cache
- `~/.unbrowse/domain-skill-cache.json` — domain-level reuse cache

## What to read next

- [API reference](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/api.md)
- [Deployment guide](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/deployment.md)
- [Codex eval harness](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/codex-eval-harness.md)
