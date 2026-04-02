# Unbrowse

This package installs the `unbrowse` CLI.

Turn any website into a reusable API interface for agents. Unbrowse captures network traffic, reverse-engineers the real endpoints underneath the UI, and stores what it learns in a shared marketplace so the next agent can reuse it instantly.

One agent learns a site once. Every later agent gets the fast path.

Unbrowse is a drop-in replacement for OpenClaw / `agent-browser` browser flows for agents: on the API-native path it is typically ~30x faster, ~90% cheaper, and turns repeated browser work into reusable route assets.

> Security note: capture and execution stay local by default. Credentials stay on your machine. Learned API contracts are published to the shared marketplace only after capture. See [SKILL.md](./SKILL.md) for the full agent-facing API reference and tool-policy guidance.

## Quick start

```bash
# Fastest full setup
npx unbrowse setup
```

`npx unbrowse setup` downloads the CLI on demand, verifies the bundled Kuri runtime, lets you register with an email-shaped display identity, registers the Open Code `/unbrowse` command when Open Code is detected, and starts the local server.

For daily use:

```bash
npm install -g unbrowse
unbrowse setup
```

If your agent host uses skills:

```bash
npx skills add unbrowse-ai/unbrowse
```

## Upgrading

Unbrowse no longer self-updates at runtime. If you already have Unbrowse installed, upgrade to the latest version after each release or the new flow may not work on your machine.

If you installed the CLI globally:

```bash
npm install -g unbrowse@latest
unbrowse setup
```

If your agent host uses skills, rerun its skill install/update command too:

```bash
npx skills add unbrowse-ai/unbrowse
```

Need help or want release updates? Join the Discord: [discord.gg/VWugEeFNsG](https://discord.gg/VWugEeFNsG)

Every CLI command auto-starts the local server on `http://localhost:6969` by default. Override with `UNBROWSE_URL`, `PORT`, or `HOST`. On first startup it auto-registers as an agent with the marketplace and caches credentials in `~/.unbrowse/config.json`. `unbrowse setup` now prompts for an email-shaped identity first; headless setups can provide `UNBROWSE_AGENT_EMAIL`.

Works with Claude Code, Open Code, Cursor, Codex, Windsurf, and any agent host that can call a local CLI or skill.

## What setup does

- Checks local prerequisites for the npm/npx flow.
- Verifies the bundled Kuri binary, or builds it from the vendored Kuri source when working from repo source with Zig installed.
- Registers the Open Code `/unbrowse` command when Open Code is present.
- Starts the local Unbrowse server unless `--no-start` is passed.

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

## Help shape the next eval

If you tried Unbrowse on a site or API and could not get it to work, add it to [Discussion #53](https://github.com/unbrowse-ai/unbrowse/discussions/53). We use that thread to collect missing or broken targets so we can turn them into requirements for the next eval pass.

## Docs

The synced skill repo also carries the longer-form docs set:

- [Whitepaper companion index](./docs/whitepaper/README.md)
- [For Technical Readers](./docs/whitepaper/for-technical-readers.md)
- [For Investors](./docs/whitepaper/for-investors.md)
- [Analytics API](./docs/analytics-api.md)

## How it works

When an agent asks for something, Unbrowse first searches the marketplace for an existing skill. If one exists with enough confidence, it executes immediately. If not, Unbrowse captures the site, learns the APIs behind it, publishes a reusable skill, and executes that instead.

Every learned skill becomes discoverable by every future agent. Reliability scoring, feedback, schema drift, and verification keep the good paths hot and the broken ones out of the way.

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

For most sites, auth is automatic. If you're logged into a site in Chrome or Firefox, Unbrowse reads your cookies directly from the browser's SQLite database — no extra steps needed. Cookies are resolved fresh on every call, so sessions stay current. For Chromium-family apps and Electron shells, `/v1/auth/steal` also accepts a custom cookie DB path or user-data dir plus an optional macOS Safe Storage service name.

| Strategy            | How it works                                       | When to use                                          |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Auto cookie resolve | Reads cookie DBs from Chrome/Firefox automatically | Default — works if you're logged in via your browser |
| Yolo mode           | Opens Chrome with your real profile                | Sites with complex auth (OAuth popups, 2FA)          |
| Interactive login   | Opens a headed browser for manual login            | Fallback when auto-resolve has no cookies            |

Auth headers (CSRF tokens, API keys, authorization headers) are captured during browsing and stored in an encrypted vault (`~/.unbrowse/vault/`). Server-side fetches replay these headers automatically — no browser launch needed. Cross-domain auth (e.g. lu.ma cookies working on api2.luma.com) is handled transparently. Stale credentials (401/403 responses) are auto-deleted.

## Mutation safety

Non-GET endpoints (POST, PUT, DELETE) require explicit confirmation:

- `dry_run: true` — preview what would execute without side effects
- `confirm_unsafe: true` — explicit user consent to proceed

GET endpoints auto-execute. Mutations never fire without opt-in.

## API reference

See [SKILL.md](./SKILL.md) for the full API reference including all endpoints, search, feedback, auth, and issue reporting.

| Method | Endpoint                 | Description                                    |
| ------ | ------------------------ | ---------------------------------------------- |
| POST   | `/v1/intent/resolve`     | Search marketplace, capture if needed, execute |
| POST   | `/v1/skills/:id/execute` | Execute a specific skill                       |
| POST   | `/v1/auth/login`         | Interactive browser login                      |
| POST   | `/v1/auth/steal`         | Import cookies from browser/Electron storage   |
| POST   | `/v1/search`             | Semantic search across all domains             |
| POST   | `/v1/search/domain`      | Semantic search scoped to a domain             |
| POST   | `/v1/feedback`           | Submit feedback (affects reliability scores)   |
| POST   | `/v1/skills/:id/verify`  | Health check skill endpoints                   |
| POST   | `/v1/skills/:id/issues`  | Report a broken skill                          |
| GET    | `/v1/skills`             | List all marketplace skills                    |
| GET    | `/v1/stats/summary`      | Platform stats                                 |
| GET    | `/health`                | Health check                                   |

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

| Variable                   | Default                 | Description                  |
| -------------------------- | ----------------------- | ---------------------------- |
| `PORT`                     | `6969`                  | Server port                  |
| `HOST`                     | `127.0.0.1`             | Server bind address          |
| `UNBROWSE_URL`             | `http://localhost:6969` | Base URL for API calls       |
| `UNBROWSE_API_KEY`         | auto-generated          | API key override             |
| `UNBROWSE_AGENT_EMAIL`     | —                       | Preferred email-style agent name for registration |
| `UNBROWSE_TOS_ACCEPTED`    | —                       | Accept ToS non-interactively |
| `UNBROWSE_NON_INTERACTIVE` | —                       | Skip readline prompts        |

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

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=unbrowse-ai/unbrowse&type=date&legend=top-left)](https://www.star-history.com/?repos=unbrowse-ai%2Funbrowse&type=date&legend=top-left)

## License

AGPL-3.0 — see [LICENSE](LICENSE).
