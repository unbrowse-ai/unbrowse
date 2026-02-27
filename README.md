# Unbrowse

[![Star History Chart](https://api.star-history.com/svg?repos=unbrowse-ai/unbrowse&type=date&legend=top-left)](https://www.star-history.com/#unbrowse-ai/unbrowse&type=date&legend=top-left)

Analyze any website's network traffic and turn it into reusable API skills, backed by a shared marketplace. Skills discovered by any agent are available to all.

> Security note: capture and execution are local by default. Credentials stay on your machine. Learned API contracts are published to the shared marketplace only after capture. See [SKILL.md](./SKILL.md) for the full API reference.

## Install

```bash
npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse
```

That's it. No manual configuration needed — credentials are auto-generated on first run.

Works with Claude Code, Cursor, Codex, Windsurf, and any agent that supports skills.

## Why this project exists

Agents that drive websites through browser automation are slow and brittle:

- full browser startup for every action
- DOM waits and selector drift
- repeated render/parse loops

Unbrowse short-circuits that path:

- **first run**: headless browser captures real network traffic, reverse-engineers API endpoints
- **later runs**: call the same behavior directly via the inferred endpoint contract

Result: faster execution (50-200ms vs seconds) and fewer UI-shape failures in action-heavy workflows.

This is the practical "agentic web" move: agents should execute capability contracts, not scrape screen pixels.

### The 100x story

**Browser-automation path:**
launch browser → render page → wait for JS hydration → inspect DOM / click and type → scrape rendered output

**Unbrowse path after learn:**
execute the captured endpoint contract → reuse inferred auth/session context → run deterministic request/response flows

The gain is not a small optimization. It is often the difference between workflows that stall and ones that feel immediate.

## How it works

1. You provide a URL and intent (e.g. "get trending searches on Google")
2. The marketplace is searched for an existing skill matching your intent
3. If found, the skill executes immediately (50-200ms)
4. If not found, a headless browser navigates to the URL and records all network traffic
5. API endpoints are extracted, scored, and filtered from the traffic
6. A reusable skill is published to the shared marketplace with endpoint schemas
7. The skill is executed and results are returned
8. Future calls — from any agent — reuse the learned skill instantly

### Intent resolution pipeline

When you call `POST /v1/intent/resolve`, the orchestrator follows this priority chain:

1. **Route cache** (5-min TTL) — instant hit if the same intent was recently resolved
2. **Marketplace search** — semantic vector search ranked by composite score: 40% embedding similarity + 30% reliability + 15% freshness + 15% verification status
3. **Live capture** — headless browser records network traffic, reverse-engineers API endpoints, publishes a new skill
4. **DOM fallback** — if no API endpoints are found (static/SSR sites), structured data is extracted from rendered HTML

Skills published by live capture become available to all agents on the network.

## Authentication for gated sites

If a site requires login, Unbrowse provides three strategies:

| Strategy | How it works | When to use |
|---|---|---|
| Interactive login | Opens a headed browser; user completes auth flow | First-time login to any site |
| Yolo mode | Opens Chrome with user's real profile (existing sessions) | Already logged in via Chrome |
| Cookie steal | Reads cookie DBs directly from Chrome/Firefox | Instant, no browser launch |

Cookies are stored in an encrypted vault (`~/.unbrowse/vault/`) and automatically loaded for subsequent captures and executions on the same domain. Stale credentials (401/403 responses) are auto-deleted.

## Mutation safety

Non-GET endpoints (POST, PUT, DELETE) require explicit confirmation:

- `dry_run: true` — preview what would execute without side effects
- `confirm_unsafe: true` — explicit user consent to proceed

GET endpoints auto-execute. Mutations never fire without opt-in.

## Marketplace

Skills are stored in a shared marketplace at `beta-api.unbrowse.ai`. On first startup the server auto-registers as an agent and caches credentials in `~/.unbrowse/config.json`. Skills published by any agent are discoverable via semantic search by all agents.

### Skill lifecycle

- **active** — published, queryable, executable
- **deprecated** — low reliability (auto-triggered after consecutive failures)
- **disabled** — endpoint down (failed verification)

A background verification loop runs every 6 hours, executing safe (GET) endpoints to detect failures and schema drift. Skills with 3+ consecutive failures are automatically deprecated.

## System layout

```
src/
├── index.ts              # Fastify server entrypoint (port 6969)
├── api/routes.ts         # HTTP route definitions
├── orchestrator/         # Intent resolution pipeline
├── execution/            # Skill/endpoint execution + retry logic
├── capture/              # Headless browser traffic recording
├── reverse-engineer/     # HAR parsing → endpoint extraction
├── extraction/           # DOM structured data extraction
├── marketplace/          # Backend API client (beta-api.unbrowse.ai)
├── client/               # Agent registration & config management
├── auth/                 # Interactive login + cookie extraction
├── vault/                # Encrypted credential storage (AES-256-CBC)
├── transform/            # Field projection + schema drift detection
├── verification/         # Periodic endpoint health checks
├── ratelimit/            # Request throttling
├── types/                # TypeScript type definitions
├── domain.ts             # Domain utilities
└── logger.ts             # Logging
```

## Configuration

### Runtime directories

```
~/.unbrowse/config.json                # API key, agent ID, registration
~/.unbrowse/vault/credentials.enc      # Encrypted credential store
~/.unbrowse/vault/.key                 # Encryption key (mode 0o600)
~/.unbrowse/skill-cache/               # Local skill manifest cache
~/.unbrowse/profiles/<domain>/         # Per-domain Chrome profiles
~/.unbrowse/logs/unbrowse-YYYY-MM-DD.log  # Daily logs
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6969` | Server port |
| `HOST` | `127.0.0.1` | Server bind address |
| `UNBROWSE_URL` | `http://localhost:6969` | Base URL for API calls |
| `UNBROWSE_API_KEY` | auto-generated | API key override |
| `UNBROWSE_TOS_ACCEPTED` | — | Accept ToS non-interactively |
| `UNBROWSE_NON_INTERACTIVE` | — | Skip readline prompts |

## API reference

See [SKILL.md](./SKILL.md) for the full API reference including all endpoints, search, feedback, auth, and issue reporting.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/intent/resolve` | Search marketplace, capture if needed, execute |
| POST | `/v1/skills/:id/execute` | Execute a specific skill |
| POST | `/v1/auth/login` | Interactive browser login |
| POST | `/v1/search` | Semantic search across all domains |
| POST | `/v1/search/domain` | Semantic search scoped to a domain |
| POST | `/v1/feedback` | Submit feedback (affects reliability scores) |
| POST | `/v1/skills/:id/verify` | Health check skill endpoints |
| POST | `/v1/skills/:id/issues` | Report a broken skill |
| GET | `/v1/skills` | List all marketplace skills |
| GET | `/v1/stats/summary` | Platform stats |
| GET | `/health` | Health check |

## License

AGPL-3.0 — see [LICENSE](LICENSE).
