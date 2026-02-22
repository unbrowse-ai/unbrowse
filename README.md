# Unbrowse

Reverse-engineer any website into reusable API skills, backed by a shared marketplace. Skills discovered by any agent are published, scored, and reusable by all agents.

## How it works

Unbrowse captures browser network traffic, reverse-engineers API endpoints, and publishes reusable "skills" to a shared marketplace. When an agent asks for something, the orchestrator first searches the marketplace for an existing skill. If one exists with sufficient confidence, it executes immediately (50-200ms). If not, a headless browser captures the site, discovers its APIs, publishes a new skill, and executes it.

Every skill published by any agent becomes discoverable by all agents via semantic search. A reliability scoring engine tracks execution success, user feedback, schema drift, and verification status to surface the best skills and auto-deprecate broken ones.

The result is a flywheel: one agent discovers an API, publishes it, and every future agent benefits. Feedback and issue reports improve skill quality over time.

## Quick start

```bash
bun install
bun src/index.ts
```

The server runs on `http://localhost:6969` by default. Override with `PORT` or `HOST` env vars. On first startup it auto-registers as an agent with the marketplace and caches credentials in `~/.unbrowse/config.json`.

## Usage

```bash
# Resolve an intent (search marketplace → capture if needed → execute)
curl -s -X POST http://localhost:6969/v1/intent/resolve \
  -H "Content-Type: application/json" \
  -d '{"intent": "get trending searches", "params": {"url": "https://google.com"}, "context": {"url": "https://google.com"}}'

# Interactive login for auth-gated sites
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://calendar.google.com"}'

# List skills in the marketplace
curl -s http://localhost:6969/v1/skills | jq .

# Semantic search for skills
curl -s -X POST http://localhost:6969/v1/search \
  -H "Content-Type: application/json" \
  -d '{"intent": "get stock prices", "k": 5}'
```

See [SKILL.md](./SKILL.md) for the full API reference.

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

| Directory | Purpose |
|-----------|---------|
| `src/` | Shared skill engine (capture, reverse-engineer, execute, orchestrate) |
| `backend/` | Cloudflare Worker API (marketplace, stats, agents, issues) |
| `frontend/` | Next.js landing page |
| `packages/skill/` | Publishable skill package (src/ symlinks to root) |

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

| Service | Sign-in URL used |
|---------|-----------------|
| Google (Calendar, Drive, Gmail...) | `accounts.google.com/ServiceLogin?continue=<target>` |
| Microsoft / Office 365 / Teams | `login.microsoftonline.com/...` |
| GitHub | `github.com/login?return_to=<path>` |
| Notion | `notion.so/login` |
| LinkedIn | `linkedin.com/login` |
| Twitter / X | `x.com/i/flow/login` |
| Slack | `slack.com/signin` |
| Atlassian (Jira, Confluence) | `id.atlassian.com/login` |
| Salesforce | `login.salesforce.com` |
| Figma | `figma.com/login` |
| Airtable | `airtable.com/login` |
| Dropbox | `dropbox.com/login` |
| HubSpot | `app.hubspot.com/login` |

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

| Path | Contents |
|------|----------|
| `~/.unbrowse/profiles/<domain>/` | Persistent browser profile (cookies, localStorage, session) |
| `~/.unbrowse/config.json` | Agent credentials and marketplace API key |
| `~/.unbrowse/logs/` | Daily debug logs |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `6969` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `UNBROWSE_URL` | `http://localhost:6969` | Base URL used by the skill |
| `UNBROWSE_API_KEY` | (auto-generated) | Marketplace API key (auto-registered on first startup) |
