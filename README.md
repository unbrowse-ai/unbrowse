# unbrowse

Reverse-engineer any website into reusable API skills. Point it at a URL, describe what you want, and unbrowse captures the browser traffic, discovers the hidden APIs, and turns them into re-executable skills — no docs needed.

## What it does

1. You say: "get trending searches from Google"
2. A headless browser navigates to the URL and records all network traffic
3. API endpoints are extracted, scored, and filtered from the HAR
4. A reusable "skill" is published with endpoint schemas and stored locally
5. The skill executes and returns structured data
6. Next time you ask the same thing, it skips the browser and replays the API call instantly

Works with any website — public or authenticated. Supports REST, GraphQL, and WebSocket endpoints.

## Install

### Option A: One-liner via npx (recommended)

```bash
npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse
```

### Option B: Install from beta.unbrowse.ai

```bash
curl -fsSL https://beta.unbrowse.ai/install | sh
```

### Option C: Manual clone

```bash
git clone https://github.com/unbrowse-ai/unbrowse.git ~/.unbrowse
cd ~/.unbrowse
bun install
```

## Prerequisites

- [Bun](https://bun.sh/) runtime
- A Gemini API key (for embeddings + skill matching) — set `GEMINI_API_KEY` in your env

## Run

```bash
bun src/index.ts
```

The server starts on `http://localhost:6969`. Set `PORT` to change it.

## Usage with Claude Code

Unbrowse ships as a Claude Code skill. Once installed, Claude can call it directly:

```
/unbrowse https://news.ycombinator.com get top stories
```

Or use it conversationally:

> "What APIs does twitter.com use?"
> "Capture the endpoints from my Notion workspace"
> "Get my Google Calendar events"

The `SKILL.md` teaches Claude the full API — capture, execute, login, schema inspection, and more.

## Quick examples

### Capture and execute in one shot

```bash
curl -s -X POST http://localhost:6969/v1/intent/resolve \
  -H "Content-Type: application/json" \
  -d '{"intent": "get trending searches", "context": {"url": "https://google.com"}}'
```

### Login to an authenticated site

```bash
# Opens a browser window — complete login manually
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://calendar.google.com"}'
```

### Yolo mode — use your existing Chrome sessions

Already logged in on Chrome? Skip the login flow entirely:

```bash
# Close Chrome first, then:
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://calendar.google.com", "yolo": true}'
```

### List learned skills

```bash
curl -s http://localhost:6969/v1/skills | jq '.[] | {id: .skill_id, domain, intent}'
```

### Execute a learned skill

```bash
curl -s -X POST http://localhost:6969/v1/skills/{skill_id}/execute \
  -H "Content-Type: application/json" \
  -d '{"params": {}, "projection": {"include": ["title", "url", "score"]}}'
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/intent/resolve` | Describe what you want — discovers, learns, and executes |
| GET | `/v1/skills` | List all learned skills |
| GET | `/v1/skills/:id` | Get skill details |
| POST | `/v1/skills/:id/execute` | Execute a learned skill |
| POST | `/v1/skills/:id/verify` | Health-check a skill's endpoints |
| GET | `/v1/skills/:id/endpoints/:eid/schema` | Get endpoint response schema |
| POST | `/v1/auth/login` | Interactive browser login (supports `yolo` mode) |
| POST | `/v1/feedback` | Submit execution feedback (1-5 rating) |
| GET | `/health` | Health check |

## How it works under the hood

- **Capture**: Playwright browser records HAR traffic while navigating the target URL
- **Reverse-engineer**: Endpoints are scored by content-type, response size, domain affinity, and data richness
- **Skill storage**: Skills are JSON manifests with endpoint descriptors, stored locally in `./skills/`
- **Vector search**: Skills are indexed with Gemini embeddings in domain-scoped namespaces for instant intent matching
- **Schema inference**: JSON response bodies are analyzed to produce JSON Schema for each endpoint
- **Auth**: Cookies are captured from browser sessions and stored in an encrypted vault, injected automatically on future requests

## License

MIT
