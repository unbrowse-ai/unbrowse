# Unbrowse

Reverse-engineer any website into reusable API skills. Captures browser network traffic, discovers endpoints, and turns them into skills that can be re-executed programmatically.

## Quick start

```bash
bun install
bun src/index.ts
```

The server runs on `http://localhost:6969` by default. Override with `PORT` or `HOST` env vars.

## Usage

```bash
# Resolve an intent (discover → learn → execute in one call)
curl -s -X POST http://localhost:6969/v1/intent/resolve \
  -H "Content-Type: application/json" \
  -d '{"intent": "get trending searches", "params": {"url": "https://google.com"}, "context": {"url": "https://google.com"}}'

# Interactive login for auth-gated sites
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url": "https://calendar.google.com"}'

# List learned skills
curl -s http://localhost:6969/v1/skills | jq .
```

See [SKILL.md](./SKILL.md) for the full API reference.

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

Example auth log output:

```
[14:02:01] [auth] interactiveLogin called — url: https://calendar.google.com, targetDomain: calendar.google.com
[14:02:01] [auth] persistent profile dir: /Users/you/.unbrowse/profiles/google.com
[14:02:03] [auth] redirected to workspace.google.com (not target, not auth provider) — navigating to sign-in: https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fcalendar.google.com
[14:02:05] [auth] navigated to: https://accounts.google.com/v3/signin/identifier?...
[14:02:28] [auth] navigated to: https://calendar.google.com/calendar/r
[14:02:28] [auth] login detected after 26 polls (26.1s) — url: https://calendar.google.com/calendar/r
[14:02:28] [auth] total cookies in context: 21
[14:02:28] [auth] cookies matching calendar.google.com: 17 — names: SID, SSID, HSID, ...
[14:02:28] [auth] vault write complete — login successful
```

Log files are plain text and safe to share when reporting issues (cookie values are present — redact before sharing if needed).

## Data directories

| Path | Contents |
|------|----------|
| `~/.unbrowse/profiles/<domain>/` | Persistent browser profile (cookies, localStorage, session) |
| `~/.unbrowse/logs/` | Daily debug logs |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `6969` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `UNBROWSE_URL` | `http://localhost:6969` | Base URL used by the skill |
