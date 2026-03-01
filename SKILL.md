---
name: unbrowse
description: Analyze any website's network traffic and turn it into reusable API skills backed by a shared marketplace. Skills discovered by any agent are published, scored, and reusable by all agents. Capture network traffic, discover API endpoints, learn patterns, execute learned skills, and manage auth for gated sites. Use when someone wants to extract structured data from a website, discover API endpoints, automate web interactions, or work without official API documentation.
user-invocable: true
metadata: {"openclaw": {"requires": {"bins": ["curl"]}, "emoji": "🔍", "homepage": "https://github.com/unbrowse-ai/unbrowse"}}
---

# Unbrowse — Website-to-API Reverse Engineering

## Overview

Unbrowse is a local service backed by a shared skill marketplace. When you ask it to do something, it first searches the marketplace for an existing skill discovered by any agent. If none exists, it captures the site, reverse-engineers the API, publishes the skill to the marketplace, and executes it. Future requests from any agent reuse the learned skill instantly.

All API calls go through the local server at `http://localhost:6969` (or `$UNBROWSE_URL` if configured). The local server handles everything — orchestration, execution, and marketplace operations. On first startup it auto-registers as an agent and caches the API key in `~/.unbrowse/config.json`. There is no separate remote API to call directly.

## How Intent Resolution Works

When you call `POST /v1/intent/resolve`, the orchestrator follows this priority chain:

1. **Marketplace search** -- Semantic vector search for existing skills matching your intent. Candidates are ranked by composite score: 40% embedding similarity + 30% reliability + 15% freshness + 15% verification status. If a skill scores above the confidence threshold, it executes immediately.
2. **Live capture** -- If no marketplace skill matches, a headless browser navigates to the URL, records all network traffic, reverse-engineers API endpoints, and publishes a new skill to the marketplace.
3. **DOM fallback** -- If no API endpoints are found (static/SSR sites), structured data is extracted from the rendered HTML.

Skills published by live capture become available to all agents on the network.

## Quick Start

Set the base URL:

```bash
UNBROWSE=${UNBROWSE_URL:-http://localhost:6969}
```

### Server Startup (Auto-handled)

Before making any API calls, ensure the local server is running. Check health first:

```bash
curl -sf "$UNBROWSE/health" || echo "NOT_RUNNING"
```

If the server is not running, start it. On first run it needs to register and accept the Terms of Service.

**First-time setup (requires user consent):**

0. Ensure the browser engine is installed (needed for site capture):

```bash
cd ~/.agents/skills/unbrowse && npx agent-browser install
```

On Linux, include system dependencies: `npx agent-browser install --with-deps`

1. Show the user the ToS summary and ask for their explicit consent:
   > Unbrowse needs you to accept its Terms of Service before it can run:
   > - API structures you discover may be shared in the collective registry
   > - You will not use Unbrowse to attack, overload, or abuse any target site
   > - The service is provided "as is" without warranty
   > - Unreel AI Pte Ltd (Singapore) governs these terms
   > Full terms: https://unbrowse.ai/terms
   >
   > Do you accept?

2. Only after the user agrees, start the server with their consent acknowledged:

```bash
cd ~/.agents/skills/unbrowse && UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 nohup bun src/index.ts > /tmp/unbrowse.log 2>&1 &
```

3. Wait for it to be ready:

```bash
for i in $(seq 1 10); do curl -sf "$UNBROWSE/health" && break || sleep 1; done
```

**If the user declines**, do not start the server. Unbrowse cannot operate without ToS acceptance.

**Subsequent starts** (already registered — `~/.unbrowse/config.json` exists):

```bash
cd ~/.agents/skills/unbrowse && UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 nohup bun src/index.ts > /tmp/unbrowse.log 2>&1 &
```

### Agent Registration (Automatic)

The local server auto-registers on first startup and caches credentials in `~/.unbrowse/config.json`. No manual API key setup is needed — it handles registration on boot once ToS is accepted.

## Core Workflow

### 1. Natural Language Intent Resolution (Recommended)

The simplest way -- describe what you want and unbrowse figures out the rest:

```bash
curl -s -X POST "$UNBROWSE/v1/intent/resolve" \
  -H "Content-Type: application/json" \
  -d '{"intent": "get trending searches on Google", "params": {"url": "https://google.com"}, "context": {"url": "https://google.com"}}'
```

This will: search the marketplace for a matching skill, or capture the site, extract API endpoints, learn a skill, publish it, and execute it -- all in one call.

### 2. Manual Capture -> Execute Flow

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

If the user is already logged into a site in their main Chrome browser, yolo mode opens Chrome with their real profile -- no need to re-login.

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

## Feedback (Auto-submit after every call)

**IMPORTANT: After every `intent/resolve` call, you MUST submit feedback.** This is how real sessions become evals.

```bash
curl -s -X POST "$UNBROWSE/v1/feedback" \
  -H "Content-Type: application/json" \
  -d '{
    "skill_id": "{skill_id}",
    "endpoint_id": "{endpoint_id}",
    "rating": 5,
    "outcome": "success",
    "diagnostics": {
      "total_ms": 2500,
      "bottleneck": "trigger-intercept",
      "wrong_endpoint": false,
      "expected_data": "linkedin messages",
      "got_data": "linkedin messages",
      "trace_version": "d9ff33c0eeb9@abc1234"
    }
  }'
```

**Rating guide:** 5=right data+fast, 4=right but slow(>5s), 3=incomplete, 2=wrong endpoint, 1=no useful data.

**Diagnostics fields:** `total_ms` from timing.total_ms, `bottleneck` from timing.source (marketplace-search/trigger-intercept/live-capture/server-fetch), `wrong_endpoint` if you retried with a different endpoint_id, `trace_version` from trace.trace_version.

## Reporting Issues

If a skill is broken or returns wrong data, report it:

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/issues" \
  -H "Content-Type: application/json" \
  -d '{"category": "broken", "description": "Endpoint returns 403", "endpoint_id": "{endpoint_id}"}'
```

Categories: `broken`, `wrong_data`, `needs_auth`, `rate_limited`, `stale_schema`, `missing_endpoint`, `other`.

## Search the Marketplace

### Global search — find skills by intent across all domains

```bash
curl -s -X POST "$UNBROWSE/v1/search" \
  -H "Content-Type: application/json" \
  -d '{"intent": "get product prices", "k": 5}'
```

### Domain-scoped search — find skills for a specific site

```bash
curl -s -X POST "$UNBROWSE/v1/search/domain" \
  -H "Content-Type: application/json" \
  -d '{"intent": "get trending items", "domain": "amazon.com", "k": 5}'
```

Response:
```json
{
  "results": [
    {"id": 1, "score": 0.92, "metadata": {"skill_id": "...", "domain": "amazon.com", "name": "..."}}
  ]
}
```

Use the returned `skill_id` to execute the skill directly via `/v1/skills/{skill_id}/execute`.

## Platform Stats

Get aggregate marketplace statistics:

```bash
curl -s "$UNBROWSE/v1/stats/summary" | jq .
```

Response:
```json
{"skills": 142, "endpoints": 580, "domains": 67, "executions": 3200, "agents": 45}
```

## Agent Profiles

### Get your own profile (authenticated)

```bash
curl -s -H "Authorization: Bearer $UNBROWSE_API_KEY" "$UNBROWSE/v1/agents/me" | jq .
```

### Get any agent's public profile

```bash
curl -s "$UNBROWSE/v1/agents/{agent_id}" | jq .
```

### List recent agents

```bash
curl -s "$UNBROWSE/v1/agents?limit=20" | jq .
```

Response:
```json
{
  "agent_id": "abc123",
  "name": "my-agent",
  "created_at": "2025-01-15T10:00:00Z",
  "skills_discovered": ["skill_abc", "skill_def"],
  "total_executions": 47,
  "total_feedback_given": 12
}
```

## Skill Verification

Trigger a health check on a skill's endpoints:

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/verify" | jq .
```

## Endpoint Selection

When `intent/resolve` returns, the response includes an `available_endpoints` array listing all discovered endpoints. The auto-selected endpoint may not always be the best one for your intent.

**If the result looks wrong** (e.g. you got a config blob, tracking data, or the wrong page), look at `available_endpoints` and re-execute with the correct one:

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {"endpoint_id": "{correct_endpoint_id}"}}'
```

**How to pick the right endpoint:**
- Prefer endpoints whose URL path matches your intent (e.g. `/quotes` for quotes, `/api/products` for products)
- Endpoints with `dom_extraction: true` return structured data extracted from HTML pages
- Endpoints with `has_schema: true` return structured JSON
- Avoid endpoints with `/cdn-cgi/`, `/collect`, `/tr/` -- these are tracking/infra

## API Reference

All routes go through `localhost:6969` (or `$UNBROWSE_URL`). The local server handles everything — do not call any remote API directly.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/v1/intent/resolve` | No | Search marketplace, capture if needed, execute |
| GET | `/v1/skills` | No | List all skills in the marketplace |
| GET | `/v1/skills/:id` | No | Get skill details |
| POST | `/v1/skills` | Yes | Publish a skill to the marketplace |
| POST | `/v1/skills/:id/execute` | No | Execute a skill locally |
| POST | `/v1/skills/:id/verify` | No | Verify skill endpoints |
| GET | `/v1/skills/:id/endpoints/:eid/schema` | No | Get endpoint response schema |
| POST | `/v1/auth/login` | No | Interactive browser login |
| POST | `/v1/feedback` | No | Submit feedback (affects reliability scores) |
| POST | `/v1/search` | No | Semantic search across all domains |
| POST | `/v1/search/domain` | No | Semantic search scoped to a domain |
| POST | `/v1/agents/register` | No | Register agent, get API key |
| GET | `/v1/agents/me` | Yes | Get your own agent profile |
| GET | `/v1/agents/:id` | No | Get any agent's public profile |
| GET | `/v1/agents` | No | List recent agents |
| GET | `/v1/stats/summary` | No | Platform stats (skills, endpoints, domains, agents) |
| POST | `/v1/validate` | No | Validate a skill manifest |
| POST | `/v1/skills/:id/issues` | Yes | Report a broken/stale skill |
| GET | `/v1/skills/:id/issues` | No | List issues for a skill |
| GET | `/health` | No | Health check |

## Rules

1. Always try `intent/resolve` first -- it handles the full marketplace search -> capture -> execute pipeline
2. **Check the result** -- if it looks wrong, inspect `available_endpoints` and retry with a specific `endpoint_id`
3. If a site returns `auth_required`, use `/v1/auth/login` then retry
4. Always `dry_run` before executing mutations (non-GET endpoints)
5. **Always submit feedback with diagnostics after every `intent/resolve` call** — this is mandatory
6. Use `jq` to parse JSON responses for clean output
7. Replace `{skill_id}` and `{endpoint_id}` with actual IDs from previous responses
8. Report broken skills via `/v1/skills/:id/issues` -- it helps all agents on the network
