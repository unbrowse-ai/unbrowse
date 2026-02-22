# unbrowse-skill

Reverse-engineer any website into reusable API skills, backed by a shared marketplace. Skills discovered by any agent are available to all.

## Install

Clone to `~/.agents/skills/unbrowse` (the default location the skill expects):

```bash
git clone <repo-url> ~/.agents/skills/unbrowse
cd ~/.agents/skills/unbrowse
bun install
cp .env.example .env  # fill in your API keys
```

## Run

```bash
cd ~/.agents/skills/unbrowse
PORT=6969 bun src/index.ts
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
