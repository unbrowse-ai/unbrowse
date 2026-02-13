# Quickstart

## 1) Install plugin and restart gateway

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
openclaw gateway restart
```

The extension side is active immediately after restart.
The marketplace side is used only when you explicitly publish and install shared skills.

## 2) Create a local skill

This is the default path.
Publishing is not required to run skills locally.

```text
unbrowse_capture { "urls": ["https://example.com"] }
```

What this writes:
- `~/.openclaw/skills/example/`
- `SKILL.md`
- generated helper scripts
- optional `auth.json` for session context

For auth-gated flows:

```text
unbrowse_login { "url": "https://example.com/login" }
unbrowse_capture { "urls": ["https://example.com/dashboard"] }
```

## 3) Replay from local artifacts

```text
unbrowse_skills
unbrowse_replay { "service": "example" }
unbrowse_replay { "service": "example", "endpoint": "GET /api/v1/me" }
```

If local artifacts exist, this stays local by default.

## 4) Learn from HAR (optional)

```text
unbrowse_learn { "harPath": "/absolute/path/traffic.har" }
```

Use this for repeatable fixtures or when you already have captured traffic.

## 5) Publish (optional)

Publishing is optional.
Use this when you want others to discover your skill and use shared execution contracts.

```text
unbrowse_publish { "service": "example", "price": "0" }
```

Discovery + install:

```text
unbrowse_search { "query": "example", "install": "<skill-id>" }
```

Published flow outcome:
- shared discoverability
- additional replay path through backend execution contracts
- local mode remains available for your private copy

## 6) Payment note

Payments are not active in this repository.
Wallet tooling may be present but should be treated as inactive for now.

## Next read list

1. `docs/ARCHITECTURE.md`
2. `docs/INTEGRATION_BOUNDARIES.md`
3. `docs/CONTRIBUTOR_PLAYBOOK.md`
4. `server/src/server/routes/README.md`
