# Quickstart

Read when: first local install, first CLI run, or CI/headless setup.

## Install

```bash
# Recommended: make Unbrowse your agent's native browser
npx unbrowse-openclaw install --restart
```

Every `page.goto()` routes through Unbrowse automatically — no code changes needed. The package pulls in the local runtime.

Alternative standalone CLI install:

```bash
curl -fsSL https://unbrowse.ai/install.sh | sh
```

The CLI installer detects platform, downloads the matching release tarball, installs `unbrowse` into `~/.local/bin`, then runs `unbrowse setup`.

Public companion docs live at [docs.unbrowse.ai](https://docs.unbrowse.ai). The repo-level agent contract lives in [SKILL.md](/Users/lekt9/.codex/worktrees/c99f/unbrowse/SKILL.md).

## Fast path

```bash
git clone --single-branch --depth 1 https://github.com/unbrowse-ai/unbrowse.git ~/unbrowse
cd ~/unbrowse && ./setup --host off
```

`./setup` is the canonical bootstrap path. It does the repo-local shim/runtime prep first, then runs the real first-use flow without depending on npm release assets:

It is one command, not literal one-click: the first successful run can still prompt for ToS acceptance and agent identity.

1. checks the local package-manager/runtime environment
2. verifies the bundled Kuri browser runtime, or builds it from vendored source when working from repo checkout with Zig available
3. installs or updates the stable `unbrowse` shim and the Open Code `/unbrowse` command when Open Code is detected
4. runs the first-use bootstrap: ToS acceptance, agent registration + API-key caching, wallet detection, then starts the local server on `http://localhost:6969` unless `--no-start` is passed

If a wallet is configured, that wallet address becomes the contributor/payment truth: it is synced onto the agent profile, used as the contributor payout destination, and used as the spending wallet for paid marketplace routes.

Recommended for new installs: set up Crossmint `lobster.cash` during bootstrap. `unbrowse setup` now encourages it, and when the tooling is already present it will try `npx @crossmint/lobster-cli setup` automatically. That wallet becomes the contributor payout destination and the spending wallet for paid marketplace routes.

Unbrowse supports wallet providers such as Crossmint `lobster.cash` for x402-gated routes. If you use `lobster.cash`, set `LOBSTER_WALLET_ADDRESS`. Other providers can use `AGENT_WALLET_ADDRESS` and optional `AGENT_WALLET_PROVIDER`.

For repeat npm installs after a healthy publish:

```bash
npm install -g unbrowse
unbrowse setup
```

If your host uses skills:

```bash
npx skills add unbrowse-ai/unbrowse
```

This is skill-only. It does not install the `unbrowse` runtime binary. Also install/setup the runtime:

```bash
npm install -g unbrowse@preview && unbrowse setup --host mcp
```

## First-run behavior

The CLI auto-starts the local server for normal commands. On the first real startup it also handles agent registration.

- If the backend is reachable, it checks the current ToS version.
- Interactive runs prompt for ToS acceptance.
- Interactive runs also let you enter an email-style agent identity. Press Enter to keep the local device id.
- Headless runs can preseed identity with `UNBROWSE_AGENT_EMAIL`.
- Non-interactive runs must set `UNBROWSE_TOS_ACCEPTED=1` after the user has agreed to the ToS.

Headless repo bootstrap:

```bash
cd ~/unbrowse && ./setup --host off --accept-tos --agent-email agent@example.com --skip-wallet-setup
```

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

## TypeScript SDK

If you want to call the same local-first flow from app code:

```bash
npm install @unbrowse/sdk
```

```ts
import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = new Unbrowse();

const result = await unbrowse.resolve({
  intent: "get trending searches",
  url: "https://google.com",
});

console.log(result.result);
```

Search the marketplace directly:

```ts
const matches = await unbrowse.searchDomain({
  intent: "find trending repositories",
  domain: "github.com",
  k: 3,
});
```

Re-execute a learned skill:

```ts
const resolved = await unbrowse.resolve({
  intent: "get stock prices",
  url: "https://finance.yahoo.com",
});

const rerun = await unbrowse.execute(resolved, {
  params: { symbol: "NVDA" },
});
```

## Working from repo checkout

Repo checkout is the truthful install path. Initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

That pulls the tracked Kuri source into `submodules/kuri`. Packaging from the monorepo bundles the platform-specific Kuri binaries from that source.

Repo presets are the supported runtime switch:

```bash
bun run preset:show
bun run preset:prod
bun run preset:testing
bun run preset:experiments
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
- [TypeScript SDK](../../packages/sdk/README.md)
- [Deployment guide](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/deployment.md)
- [Codex eval harness](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/codex-eval-harness.md)
