---
name: unbrowse
description: Reverse-engineer any website into reusable API skills. Capture network traffic, discover endpoints, learn API patterns, execute learned skills, and manage auth for gated sites. Use when someone wants to scrape structured data from a website, discover hidden APIs, automate web interactions, or bypass the need for official API documentation.
user-invocable: true
metadata: {"openclaw": {"requires": {"bins": ["curl"]}, "emoji": "🔍", "homepage": "https://github.com/anthropics/unbrowse"}}
---

# Unbrowse — Website-to-API Reverse Engineering

## Overview

Unbrowse is a local service that captures browser network traffic, reverse-engineers API endpoints, and turns them into reusable "skills" that can be re-executed programmatically. It runs on `http://localhost:6969` (or `$UNBROWSE_URL` if configured).

## Quick Start

Set the base URL:

```bash
UNBROWSE=${UNBROWSE_URL:-http://localhost:6969}
```

## Core Workflow

### 1. Natural Language Intent Resolution (Recommended)

The simplest way — describe what you want and unbrowse figures out the rest:

```bash
curl -s -X POST "$UNBROWSE/v1/intent/resolve" \
  -H "Content-Type: application/json" \
  -d '{"intent": "get trending searches on Google", "params": {"url": "https://google.com"}, "context": {"url": "https://google.com"}}'
```

This will: discover a matching skill or capture the site, extract API endpoints, learn a skill, and execute it — all in one call.

### 2. Manual Capture → Execute Flow

#### Step 1: Capture a website

```bash
curl -s -X POST "$UNBROWSE/v1/intent/resolve" \
  -H "Content-Type: application/json" \
  -d '{"intent": "capture APIs from this site", "params": {"url": "https://example.com"}, "context": {"url": "https://example.com"}}'
```

#### Step 2: List learned skills

```bash
curl -s "$UNBROWSE/v1/skills" | jq .
```

#### Step 3: Execute a specific skill

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {}}'
```

#### Step 4: Inspect endpoint schema

```bash
curl -s "$UNBROWSE/v1/skills/{skill_id}/endpoints/{endpoint_id}/schema" | jq .
```

## Authentication for Gated Sites

If a site requires login:

### Interactive Login (opens a browser window)

```bash
curl -s -X POST "$UNBROWSE/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/login"}'
```

The user completes login in the browser. Cookies are stored in the vault and automatically used for subsequent captures and executions on that domain.

### Yolo Login (use existing Chrome sessions)

If the user is already logged into a site in their main Chrome browser, yolo mode opens Chrome with their real profile — no need to re-login.

**Important: Always ask the user before using yolo mode.** Say: "I'll open your main Chrome browser with all your existing sessions. You'll need to close Chrome first. OK to proceed?"

```bash
curl -s -X POST "$UNBROWSE/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "yolo": true}'
```

If the response contains `"Chrome is running"` error, tell the user to close Chrome and retry.

### After Login, Re-capture

```bash
curl -s -X POST "$UNBROWSE/v1/intent/resolve" \
  -H "Content-Type: application/json" \
  -d '{"intent": "get my dashboard data", "params": {"url": "https://example.com/dashboard"}, "context": {"url": "https://example.com"}}'
```

Stored auth cookies are automatically loaded from the vault.

## Mutation Safety

For non-GET endpoints (POST, PUT, DELETE), unbrowse requires explicit confirmation:

### Dry Run (preview what would execute)

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {}, "dry_run": true}'
```

### Confirm Unsafe Execution

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {}, "confirm_unsafe": true}'
```

**Always use dry_run first for mutations. Ask the user before passing confirm_unsafe.**

## Field Projection

Request only specific fields from the response:

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {}, "projection": {"include": ["title", "url", "score"]}}'
```

## Feedback

Report whether a skill execution was useful:

```bash
curl -s -X POST "$UNBROWSE/v1/feedback" \
  -H "Content-Type: application/json" \
  -d '{"target_type": "skill", "target_id": "{skill_id}", "endpoint_id": "{endpoint_id}", "outcome": "success", "rating": 5}'
```

Ratings (1-5) affect the skill's reliability score and future ranking.

## Skill Verification

Trigger a health check on a skill's endpoints:

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/verify" | jq .
```

## API Reference

All routes go through `localhost:6969`. Local routes are handled directly; marketplace/search routes are proxied to the beta API automatically.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/intent/resolve` | Resolve intent → find/learn/execute skill |
| GET | `/v1/skills` | List all learned skills (proxied to beta API) |
| GET | `/v1/skills/:id` | Get skill details (proxied to beta API) |
| POST | `/v1/skills` | Publish a new skill (proxied to beta API) |
| POST | `/v1/skills/:id/execute` | Execute a learned skill |
| POST | `/v1/skills/:id/verify` | Verify skill endpoints |
| GET | `/v1/skills/:id/endpoints/:eid/schema` | Get endpoint response schema (proxied to beta API) |
| POST | `/v1/auth/login` | Interactive browser login |
| POST | `/v1/feedback` | Submit execution feedback |
| POST | `/v1/search` | Semantic search for skills (proxied to beta API) |
| GET | `/health` | Health check |

## Rules

1. Always try `intent/resolve` first — it handles the full discover→learn→execute pipeline
2. If a site returns `auth_required`, use `/v1/auth/login` then retry
3. Always `dry_run` before executing mutations (non-GET endpoints)
4. Submit feedback after executions to improve skill reliability scores
5. Use `jq` to parse JSON responses for clean output
6. Replace `{skill_id}` and `{endpoint_id}` with actual IDs from previous responses
