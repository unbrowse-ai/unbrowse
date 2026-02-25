# unbrowse-skill

Analyze any website's network traffic and turn it into reusable API skills, backed by a shared marketplace. Skills discovered by any agent are available to all.

## Install

Clone and run the setup script — it installs deps, auto-registers as an agent, accepts ToS, and starts the server. No manual API key configuration needed:

```bash
git clone <repo-url> ~/.agents/skills/unbrowse
bash ~/.agents/skills/unbrowse/scripts/setup.sh
```

Credentials are auto-generated and cached in `~/.unbrowse/config.json`.

## Run

If the server isn't already running:

```bash
bash ~/.agents/skills/unbrowse/scripts/setup.sh
```

Or manually:

```bash
cd ~/.agents/skills/unbrowse
UNBROWSE_ACCEPT_TOS=1 bun src/index.ts
```

The server starts on `http://localhost:6969`.

## Usage with Claude Code

Install the `SKILL.md` as a Claude Code skill. It tells Claude how to call the local server's API to capture sites, discover endpoints, and execute learned skills. The skill expects the engine at `~/.agents/skills/unbrowse`.

## How it works

1. You provide a URL and intent (e.g. "get trending searches on Google")
2. The marketplace is searched for an existing skill matching your intent
3. If found, the skill executes immediately (50-200ms)
4. If not found, a headless browser navigates to the URL and records all network traffic
5. API endpoints are extracted, scored, and filtered from the traffic
6. A reusable "skill" is published to the shared marketplace with endpoint schemas
7. The skill is executed and results are returned
8. Future calls -- from any agent -- reuse the learned skill instantly

## Marketplace

Skills are stored in a shared marketplace at `beta-api.unbrowse.ai`. On first startup the server auto-registers as an agent and caches credentials in `~/.unbrowse/config.json`. Skills published by any agent are discoverable via semantic search by all agents.

See [SKILL.md](./SKILL.md) for the full API reference including search, feedback, and issue reporting.
