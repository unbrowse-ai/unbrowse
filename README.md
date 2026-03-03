# Unbrowse

[![Star History Chart](https://api.star-history.com/svg?repos=unbrowse-ai/unbrowse&type=date&legend=top-left)](https://www.star-history.com/#unbrowse-ai/unbrowse&type=date&legend=top-left)

The browser that agents actually need. Instead of rendering pixels for software that doesn't have eyes, Unbrowse reverse-engineers the APIs underneath every website and turns them into reusable, structured endpoint contracts.

Skills discovered by any agent are published to a shared marketplace and instantly available to all agents.

> Security note: capture and execution are local by default. Credentials stay on your machine. Learned API contracts are published to the shared marketplace only after capture. See [SKILL.md](./SKILL.md) for the full API reference.

## What's new

**Auth just works now.** Unbrowse reads cookies directly from your Chrome and Firefox databases — no manual login flows needed for most sites. If you're logged into a site in your browser, Unbrowse can use those sessions automatically. Cookies are resolved fresh on every call, expired cookies are filtered out, and cross-domain redirects (e.g. lu.ma → luma.com) are handled transparently. Auth headers (CSRF tokens, API keys) captured during browsing are stored encrypted and replayed on server-side fetches.

**Extraction hints.** Large API responses no longer require agents to guess `--path` values through trial and error. The engine analyzes response schemas at inference time and returns `extraction_hints` with the exact path, fields, and ready-to-paste CLI args. Agents get structured data on the first try.

**JS bundle scanning.** During capture, Unbrowse scans JavaScript bundles for API routes that were never triggered by network traffic. Endpoints like `/api/search` that only fire on user interaction are now discovered automatically — zero extra requests, since the bundles are already downloaded.

**Auto-update.** The skill silently updates itself in the background every 4 hours. No more manual `npx skills update`.

**10x faster execution.** Server-side fetch with stored auth headers means most calls skip the browser entirely — 120s → 100ms. Local disk cache eliminates marketplace latency for known domains.

## Install

```bash
npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse
```

No manual configuration needed — credentials are auto-generated on first run.

Works with Claude Code, Cursor, Codex, Windsurf, and any agent that supports skills.

## The problem

Every AI company building agents hits the same wall: **browsers don't work for machines.**

Browser automation hammers servers with full page loads just to extract one data point. It's slow, unreliable, and expensive for everyone. Sites hate it. Developers hate it. Everyone loses.

The current approaches all fail at scale:

| Approach | What it does | Why it breaks |
|---|---|---|
| **Computer Use** | Screenshots + click coordinates | 30-60s per action, $0.10+ per page, breaks on any UI change |
| **Web Scraping** | Parse HTML into structured data | Constant maintenance, blocked by anti-bot, no auth handling |
| **MCP Servers** | Hand-built integrations per site | 1B+ sites on the web, ~50 MCP servers. Will never reach 1% |

The agentic web won't be built on browsers. It'll be built on APIs.

## What Unbrowse does

An agent connects to Unbrowse and says "I need to search flights on Skyscanner." Instead of launching a browser, loading a page, clicking buttons, and parsing HTML — it gets a clean API call back. Structured JSON in milliseconds.

**What agents see today:** 4,847 DOM nodes, 12.4 seconds to parse.

**What Unbrowse sees:** 4 clean API endpoints, ~200ms, structured JSON.

| | Browser automation | Unbrowse |
|---|---|---|
| **Speed** | 5-30 seconds per action | 50-200ms |
| **Reliability** | Breaks on any UI/selector change | Stable API contracts |
| **Cost** | $0.10+ per page load | ~90% cheaper |
| **Output** | Raw HTML / screenshots | Structured JSON |
| **Maintenance** | Constant | Self-healing via marketplace |

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

## The marketplace flywheel

Every new user makes the platform more valuable for the next one — like Waze, but for the web's APIs.

```
More Users → More Skills → More Domains → More Value
    ↑                                          |
    └──────────────────────────────────────────┘
```

Skills are stored in a shared marketplace at `beta-api.unbrowse.ai`. On first startup the server auto-registers as an agent and caches credentials in `~/.unbrowse/config.json`. Skills published by any agent are discoverable via semantic search by all agents.

### Skill lifecycle

- **active** — published, queryable, executable
- **deprecated** — low reliability (auto-triggered after consecutive failures)
- **disabled** — endpoint down (failed verification)

A background verification loop runs every 6 hours, executing safe (GET) endpoints to detect failures and schema drift. Skills with 3+ consecutive failures are automatically deprecated.

## Authentication for gated sites

For most sites, auth is automatic. If you're logged into a site in Chrome or Firefox, Unbrowse reads your cookies directly from the browser's SQLite database — no extra steps needed. Cookies are resolved fresh on every call, so sessions stay current.

| Strategy | How it works | When to use |
|---|---|---|
| Auto cookie resolve | Reads cookie DBs from Chrome/Firefox automatically | Default — works if you're logged in via your browser |
| Yolo mode | Opens Chrome with your real profile | Sites with complex auth (OAuth popups, 2FA) |
| Interactive login | Opens a headed browser for manual login | Fallback when auto-resolve has no cookies |

Auth headers (CSRF tokens, API keys, authorization headers) are captured during browsing and stored in an encrypted vault (`~/.unbrowse/vault/`). Server-side fetches replay these headers automatically — no browser launch needed. Cross-domain auth (e.g. lu.ma cookies working on api2.luma.com) is handled transparently. Stale credentials (401/403 responses) are auto-deleted.

## Mutation safety

Non-GET endpoints (POST, PUT, DELETE) require explicit confirmation:

- `dry_run: true` — preview what would execute without side effects
- `confirm_unsafe: true` — explicit user consent to proceed

GET endpoints auto-execute. Mutations never fire without opt-in.

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

## License

AGPL-3.0 — see [LICENSE](LICENSE).
