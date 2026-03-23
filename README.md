# Unbrowse

This package installs the `unbrowse` CLI.

Turn any website into a reusable API interface for agents. Unbrowse captures network traffic, reverse-engineers the real endpoints underneath the UI, and stores what it learns in a shared marketplace so the next agent can reuse it instantly.

One agent learns a site once. Every later agent gets the fast path.

> Security note: capture and execution stay local by default. Credentials stay on your machine. Learned API contracts are published to the shared marketplace only after capture. See [SKILL.md](./SKILL.md) for the full agent-facing API reference and tool-policy guidance.

Docs and whitepaper companion:

- https://docs.unbrowse.ai

## Quick start

```bash
# Fastest path: detect installed hosts and wire them automatically
curl -fsSL https://www.unbrowse.ai/install.sh | bash
```

The installer detects supported hosts and wires Unbrowse into them automatically:

- Cursor
- Windsurf
- Claude Code
- Claude Desktop
- Codex
- OpenClaw

Manual path still works:

```bash
npm install -g unbrowse
unbrowse health
```

If you prefer manual host wiring, install the CLI first:

```bash
npm install -g unbrowse
unbrowse health
```

If your agent host uses skills:

```bash
npx skills add unbrowse-ai/unbrowse
```

If you use OpenClaw, use the native plugin path instead:

```bash
openclaw plugins install unbrowse-openclaw
openclaw config set plugins.entries.unbrowse-openclaw.enabled true --strict-json
openclaw config set plugins.entries.unbrowse-openclaw.config.routingMode '"strict"' --strict-json
openclaw config set plugins.entries.unbrowse-openclaw.config.preferInBootstrap true --strict-json
openclaw gateway restart
```

## Upgrading

Unbrowse now checks npm for a newer CLI release before each command. If your installed copy is stale, it upgrades the global npm install in place when possible, otherwise it re-runs the command through the latest npm package immediately.

Disable that behavior with `UNBROWSE_DISABLE_AUTO_UPDATE=1`.

If you want to refresh a global install manually anyway:

```bash
npm install -g unbrowse@latest
```

If your agent host uses skills, rerun its skill install/update command too:

```bash
npx skills add unbrowse-ai/unbrowse
```

If you use OpenClaw, rerun the plugin install/update command too:

```bash
openclaw plugins install unbrowse-openclaw
```

Need help or want release updates? Join the Discord: [discord.gg/VWugEeFNsG](https://discord.gg/VWugEeFNsG)

Every CLI command auto-starts the local server on `http://localhost:6969` by default. Override with `UNBROWSE_URL`, `PORT`, or `HOST`. If no registration exists yet, the CLI now auto-runs registration before executing the command and caches credentials in `~/.unbrowse/config.json`. Set `UNBROWSE_AGENT_EMAIL` to control the displayed registration identity in headless setups.

Using Unbrowse means accepting the Terms of Service: discovered API structures may be shared in the collective registry, and you must not use Unbrowse to attack, overload, or abuse target sites. Full terms: https://unbrowse.ai/terms

Works with Claude Code, Open Code, Cursor, Codex, Windsurf, and any agent host that can call a local CLI or skill.

## Automatic bootstrap

- Any CLI command auto-registers first if needed.
- Any CLI command auto-starts the local server unless `--no-auto-start` is passed.
- Browser/runtime checks happen lazily as capture needs them.
- `scripts/install-agent-integrations.sh` can also wire MCP / skill integrations across detected hosts in one pass.

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

For product docs, whitepaper companion pages, and shipped-vs-roadmap guidance, use:

- https://docs.unbrowse.ai

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
