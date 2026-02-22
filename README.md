# unbrowse-skill

Reverse-engineer any website into reusable API skills. Captures browser traffic, discovers API endpoints, and turns them into re-executable skills.

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
2. A headless browser navigates to the URL and records all network traffic
3. API endpoints are extracted, scored, and filtered from the traffic
4. A reusable "skill" is published to the marketplace with endpoint schemas
5. The skill is executed and results are returned
6. Future calls for the same intent reuse the learned skill instantly
