# unbrowse-skill

Reverse-engineer any website into reusable API skills. Captures browser traffic, discovers API endpoints, and turns them into re-executable skills.

## Install

```bash
bun install
```

## Configure

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

## Run

```bash
PORT=6969 bun src/index.ts
```

The server starts on `http://localhost:6969`.

## Usage with Claude Code

Install as a Claude Code skill — the `SKILL.md` provides the interface definition. Claude Code will call the local server's API to capture sites, discover endpoints, and execute learned skills.

## How it works

1. You provide a URL and intent (e.g. "get trending searches on Google")
2. A headless browser navigates to the URL and records all network traffic
3. API endpoints are extracted, scored, and filtered from the traffic
4. A reusable "skill" is published to the marketplace with endpoint schemas
5. The skill is executed and results are returned
6. Future calls for the same intent reuse the learned skill instantly
