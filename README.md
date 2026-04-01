# Unbrowse

Turn any website into a reusable API interface for agents. Unbrowse captures network traffic, reverse-engineers the real endpoints underneath the UI, and stores what it learns in a shared marketplace so the next agent can reuse it instantly.

One agent learns a site once. Every later agent gets the fast path.

> Security note: capture and execution stay local by default. Credentials stay on your machine. Learned API contracts are published to the shared marketplace only after capture. See [SKILL.md](./SKILL.md) for the full agent-facing API reference and tool-policy guidance.

## Quick start

```bash
# 30-second setup — clone, register skill, start server
git clone --single-branch --depth 1 https://github.com/unbrowse-ai/unbrowse.git ~/.claude/skills/unbrowse \
  && cd ~/.claude/skills/unbrowse && ./setup
```

The setup script installs dependencies, auto-detects your agent host (Claude Code, Codex), registers the `/unbrowse` skill, then delegates to the CLI for Kuri verification, marketplace registration, and server startup.

### Alternative: npm install

For a standalone CLI without the skill integration:

```bash
npx unbrowse setup
npm install -g unbrowse     # or install globally for daily use
unbrowse setup
```

### Setup flags

| Flag | Description |
| ---- | ----------- |
| `--host claude\|codex\|opencode\|auto` | Force a specific agent host (default: auto-detect) |
| `--no-start` | Skip starting the server after setup |

## Upgrading

If you installed via git clone:

```bash
cd ~/.claude/skills/unbrowse && git pull && ./setup
```

If you installed via npm:

```bash
npm install -g unbrowse@latest
unbrowse setup
```

Need help or want release updates? Join the Discord: [discord.gg/VWugEeFNsG](https://discord.gg/VWugEeFNsG)

Every CLI command auto-starts the local server on `http://localhost:6969` by default. Override with `UNBROWSE_URL`, `PORT`, or `HOST`. On first startup it auto-registers as an agent with the marketplace and caches credentials in `~/.unbrowse/config.json`.

Works with Claude Code, Open Code, Cursor, Codex, Windsurf, and any agent host that can call a local CLI or skill.

## Repo checkout

For monorepo development, initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

This pulls the tracked Kuri source into `submodules/kuri` from [justrach/kuri](https://github.com/justrach/kuri.git). `npm pack --workspace packages/skill` then bundles platform-specific Kuri binaries from that source into the published CLI package.

## What setup does

- Checks prerequisites (Node.js 18+ or Bun).
- Installs dependencies if `node_modules/` is missing.
- Auto-detects installed agent hosts and creates skill symlinks.
- Delegates to `unbrowse setup` for Kuri verification, Open Code registration, marketplace registration, and server startup.

## Common commands

```bash
unbrowse health
unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty
unbrowse login --url "https://calendar.google.com"
unbrowse skills
unbrowse search --intent "get stock prices"
```

## Demo notes

- First-time capture/indexing on a site can take 20-80 seconds. That is the slow path; repeats should be much faster.
- For website tasks, keep the agent on Unbrowse instead of letting it drift into generic web search or ad hoc `curl`.
- Reddit is still a harder target than most sites because of anti-bot protections. Prefer canonical `.json` routes when available.

## How it works

When an agent asks for something, Unbrowse first searches the marketplace for an existing skill. If one exists with enough confidence, it executes immediately. If not, Unbrowse captures the site, learns the APIs behind it, publishes a reusable skill, and executes that instead.

Every learned skill becomes discoverable by every future agent. Reliability scoring, feedback, schema drift, and verification keep the good paths hot and the broken ones out of the way.

## Architecture

Unbrowse is a monorepo with two tiers:

**Local server** (`localhost:6969`) -- Handles the core workflow: intent resolution, browser capture, skill execution, auth management. Local routes are handled directly; marketplace routes are proxied transparently.

**Backend API** (`beta-api.unbrowse.ai`) -- Cloudflare Worker that powers the shared marketplace:

- **Skill storage** -- KV-backed skill manifests with versioning and intent-based dedup
- **Discovery** -- Semantic vector search using Gemini embeddings (1536-dim) indexed in EmergentDB, with KV keyword fallback
- **Scoring** -- EMA-based reliability scoring factoring success ratio, consecutive failures, feedback ratings, schema drift, and verification status
- **Agents** -- Self-registration via Unkey API keys, profiles tracking contributions (skills discovered, executions, feedback given)
- **Issues** -- Agents can report broken/stale skills with categories (broken, wrong_data, needs_auth, rate_limited, stale_schema, missing_endpoint)

### Monorepo structure

| Directory         | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `src/`            | Shared skill engine (capture, reverse-engineer, execute, orchestrate) |
| `backend/`        | Cloudflare Worker API (marketplace, stats, agents, issues)            |
| `frontend/`       | Next.js landing page                                                  |
| `packages/skill/` | Publishable skill package (src/ symlinks to root)                     |

## Marketplace

### Skill discovery

The orchestrator searches the marketplace using semantic vector search (Gemini embeddings + EmergentDB). Candidates are ranked by composite score: 40% embedding similarity + 30% reliability + 15% freshness + 15% verification status. Searches can be global or scoped to a specific domain.

### Skill lifecycle

Skills are versioned (semver). Re-publishing the same intent+domain bumps the minor version. Skills can be `active` or `deprecated`. Auto-deprecation happens when all endpoints are dead (disabled or failed).

### Reliability scoring

Each endpoint has a reliability score (0-1) computed from:

- Success/failure ratio (EMA-weighted)
- Consecutive failures (penalized)
- Verification status (verified = bonus, failed/disabled = penalty)
- User feedback ratings (1-5 scale)
- Schema drift count

Endpoints with 5+ consecutive failures are auto-disabled.

### Issue reporting

Agents can report issues on skills via `POST /v1/skills/:id/issues`. Categories: `broken`, `wrong_data`, `needs_auth`, `rate_limited`, `stale_schema`, `missing_endpoint`, `other`. Issues follow an open -> acknowledged -> resolved lifecycle.

### Agent registration

On first startup, the local server auto-registers with the marketplace and receives an API key (Unkey). Agent profiles track skills discovered, total executions, and feedback given. Public profiles are visible via `GET /v1/agents`.

## Authentication

For sites that require login, unbrowse opens a visible browser window and waits for you to complete the login flow. Cookies and session state are saved to a persistent profile under `~/.unbrowse/profiles/<domain>/` and reused automatically on subsequent captures.

```bash
# Login once
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://calendar.google.com"}'

# All future captures for that domain use the saved session automatically
curl -s -X POST http://localhost:6969/v1/intent/resolve \
  -H "Content-Type: application/json" \
  -d '{"intent": "get my upcoming events", "params": {"url": "https://calendar.google.com"}}'
```

### How marketing-page redirects are handled

Many sites redirect unauthenticated users to a marketing or product page (e.g. `calendar.google.com` -> `workspace.google.com/products/calendar`) instead of a login form. Unbrowse detects this after the initial navigation and automatically redirects the browser to the correct sign-in URL.

Built-in providers:

| Service                            | Sign-in URL used                                     |
| ---------------------------------- | ---------------------------------------------------- |
| Google (Calendar, Drive, Gmail...) | `accounts.google.com/ServiceLogin?continue=<target>` |
| Microsoft / Office 365 / Teams     | `login.microsoftonline.com/...`                      |
| GitHub                             | `github.com/login?return_to=<path>`                  |
| Notion                             | `notion.so/login`                                    |
| LinkedIn                           | `linkedin.com/login`                                 |
| Twitter / X                        | `x.com/i/flow/login`                                 |
| Slack                              | `slack.com/signin`                                   |
| Atlassian (Jira, Confluence)       | `id.atlassian.com/login`                             |
| Salesforce                         | `login.salesforce.com`                               |
| Figma                              | `figma.com/login`                                    |
| Airtable                           | `airtable.com/login`                                 |
| Dropbox                            | `dropbox.com/login`                                  |
| HubSpot                            | `app.hubspot.com/login`                              |

For anything not in this table, unbrowse falls back to `<origin>/login`. If that's wrong, pass the login URL directly instead of the app URL:

```bash
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://app.example.com/auth/sso"}'
```

To add a new provider, append an entry to `SIGN_IN_PROVIDERS` in `src/auth/index.ts`.

## Debug logs

All auth and capture activity is logged to:

```
~/.unbrowse/logs/unbrowse-YYYY-MM-DD.log
```

A new file is created each day. Logs are also printed to the server terminal in real time.

To tail live logs:

```bash
tail -f ~/.unbrowse/logs/unbrowse-$(date +%F).log
```

Log files are plain text and safe to share when reporting issues (cookie values are present -- redact before sharing if needed).

## Data directories

| Path                             | Contents                                                    |
| -------------------------------- | ----------------------------------------------------------- |
| `~/.unbrowse/profiles/<domain>/` | Persistent browser profile (cookies, localStorage, session) |
| `~/.unbrowse/config.json`        | Agent credentials and marketplace API key                   |
| `~/.unbrowse/logs/`              | Daily debug logs                                            |

## Environment variables

| Variable           | Default                 | Description                                            |
| ------------------ | ----------------------- | ------------------------------------------------------ |
| `PORT`             | `6969`                  | Server port                                            |
| `HOST`             | `127.0.0.1`             | Server bind address (localhost only by default)        |
| `UNBROWSE_URL`     | `http://localhost:6969` | Base URL used by the skill                             |
| `UNBROWSE_API_KEY` | (auto-generated)        | Marketplace API key (auto-registered on first startup) |
