# Quickstart

Get started with Unbrowse quickly:

## 1) Install

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
openclaw gateway restart
```

## 2) Generate A Skill

Option A: capture by browsing (recommended for most sites)

```text
unbrowse_capture { "urls": ["https://example.com"] }
```

Option B: learn from an existing HAR

```text
unbrowse_learn { "harPath": "/path/to/traffic.har" }
```

Both commands write a local skill folder (default: `~/.openclaw/skills/<service>/`) containing:
- `SKILL.md`
- `auth.json` (local auth material)
- `scripts/`

## 3) List Skills

```text
unbrowse_skills
```

## 4) Replay Captured Endpoints

```text
unbrowse_replay { "service": "<service-name>" }
```

Or a specific endpoint:

```text
unbrowse_replay { "service": "<service-name>", "endpoint": "GET /api/v1/me" }
```

## 5) Marketplace (Optional)

Set up a wallet (required for paid execution and publishing):

```text
unbrowse_wallet { "action": "create" }
```

Search + install:

```text
unbrowse_search { "query": "twitter" }
unbrowse_search { "install": "<skillId>" }
```

Publish one of your local skills:

```text
unbrowse_publish { "service": "<service-name>", "price": "0" }
```

What publishing means:
- Your publish contributes skill metadata + endpoint evidence to the shared index.
- Eligible contribution rewards are in `FDRY` (based on backend reward policy and execution outcomes).
- Marketplace/index executions run on the backend executor (server-side).
- Download gating is optional policy; most value capture should happen on execution.
- Local-only mode is still supported: if you reverse engineer and replay locally, calls run locally without publishing.

## Next Reads

- Architecture: `docs/ARCHITECTURE.md`
- Agent-oriented editing workflow: `docs/LLM_DEV_GUIDE.md`
