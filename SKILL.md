---
name: unbrowse
description: Analyze any website's network traffic and turn it into reusable API skills backed by a shared marketplace. Skills discovered by any agent are published, scored, and reusable by all agents. Capture network traffic, discover API endpoints, learn patterns, execute learned skills, and manage auth for gated sites. Use when someone wants to extract structured data from a website, discover API endpoints, automate web interactions, or work without official API documentation.
user-invocable: true
metadata: {"openclaw": {"requires": {"bins": ["curl"]}, "emoji": "🔍", "homepage": "https://github.com/unbrowse-ai/unbrowse"}}
---

# Unbrowse — Drop-in Browser Replacement for Agents

Browse once, cache the APIs, reuse them instantly. First call discovers and learns the site's APIs (~20-80s). Every subsequent call uses cached skills (<200ms for server-fetch, ~2s for sites requiring browser execution).

All calls go through `http://localhost:6969` (or `$UNBROWSE_URL`).

## Server Startup

```bash
UNBROWSE=${UNBROWSE_URL:-http://localhost:6969}
curl -sf "$UNBROWSE/health" || echo "NOT_RUNNING"
```

If not running, start it. First time requires ToS acceptance — ask the user:

> Unbrowse needs you to accept its Terms of Service:
> - Discovered API structures may be shared in the collective registry
> - You will not use Unbrowse to attack, overload, or abuse any target site
> Full terms: https://unbrowse.ai/terms

After consent:

```bash
cd ~/.agents/skills/unbrowse && UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 nohup bun src/index.ts > /tmp/unbrowse.log 2>&1 &
for i in $(seq 1 10); do curl -sf "$UNBROWSE/health" && break || sleep 1; done
```

First run also needs the browser engine: `cd ~/.agents/skills/unbrowse && npx agent-browser install`

## Core Usage

### Resolve an intent (recommended — handles everything)

```bash
curl -s -X POST "$UNBROWSE/v1/intent/resolve" \
  -H "Content-Type: application/json" \
  -d '{"intent": "get my bookmarked tweets", "params": {"url": "https://x.com/i/bookmarks"}, "context": {"url": "https://x.com/i/bookmarks"}}'
```

This searches the marketplace for a cached skill, or captures the site and learns one. The response includes `result`, `trace`, `timing`, `skill`, and `available_endpoints`.

### Execute a specific endpoint

If the auto-selected endpoint is wrong, pick from `available_endpoints`:

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {"endpoint_id": "{correct_endpoint_id}"}}'
```

### Reading the response

**IMPORTANT: Always read `.result` — never dig into `.trace.result`.**

If `recipe_applied: true` is in the response, the data is already parsed:
```
.result.data[]    → array of clean, flat objects (e.g. {author, text, posted})
.result._recipe   → metadata: source, items_before/after_filter, fields_mapped
```

If no recipe exists, `.result` contains the raw API response — parse it yourself and consider submitting a recipe (see Extraction Recipes below).

## Authentication

**Automatic.** Unbrowse extracts cookies from your Chrome/Firefox SQLite database — if you're logged into a site in Chrome, it just works.

If `auth_required` is returned (never logged in, cookies expired):

```bash
curl -s -X POST "$UNBROWSE/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/login"}'
```

User completes login in the browser window. Cookies are stored and reused automatically.

## Feedback (MANDATORY after every call)

**You MUST submit feedback after every `intent/resolve` call.** This is how real sessions become evals.

```bash
curl -s -X POST "$UNBROWSE/v1/feedback" \
  -H "Content-Type: application/json" \
  -d '{
    "skill_id": "{skill_id}",
    "endpoint_id": "{endpoint_id}",
    "rating": 5,
    "outcome": "success",
    "diagnostics": {
      "total_ms": 150,
      "bottleneck": "server-fetch",
      "wrong_endpoint": false,
      "expected_data": "bookmarked tweets",
      "got_data": "bookmark collections",
      "trace_version": "d9ff33c0eeb9@abc1234"
    }
  }'
```

**Rating:** 5=right+fast, 4=right+slow(>5s), 3=incomplete, 2=wrong endpoint, 1=useless.

**Diagnostics:** `total_ms` from timing.total_ms, `bottleneck` from timing.source, `wrong_endpoint` if you retried, `trace_version` from trace.trace_version.

## Extraction Recipes

When an API returns deeply-nested or mixed-entity responses, submit an extraction recipe so future agents get clean, structured output automatically.

### When to submit

After you figure out how to parse a response that has:
- A large array with mixed entity types needing filtering (e.g. LinkedIn's `included[]`)
- Deeply nested fields that should be flattened
- Lots of noise (tracking IDs, URNs, ephemeral metadata)

### Submit a recipe

```bash
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/endpoints/{endpoint_id}/recipe" \
  -H "Content-Type: application/json" \
  -d '{
    "recipe": {
      "source": "included",
      "filter": {"field": "$type", "contains": "Update"},
      "require": ["commentary"],
      "fields": {
        "author": "actor.name.text",
        "headline": "actor.description.text",
        "posted": "actor.subDescription.text",
        "text": "commentary.text.text"
      },
      "compact": true,
      "description": "Extract posts from LinkedIn feed"
    }
  }'
```

### Recipe format

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | yes | Dot-path to the source array, e.g. `"included"` or `"data.items"` |
| `filter` | object | no | `{ field, equals?, contains?, in? }` — filter array items |
| `require` | string[] | no | Fields that must be non-null |
| `fields` | object | yes | `{ outputName: "deep.path.to.value" }` — flatten nested data |
| `compact` | boolean | no | Strip nulls and empty values |
| `description` | string | no | What this recipe extracts |

Recipes auto-apply on all future executions. To get raw data, pass `"projection": {"raw": true}`.

## Debugging

Check recent session history for a domain:

```bash
curl -s "$UNBROWSE/v1/sessions/www.linkedin.com?limit=10" | jq '.entries[]'
```

Every call is auto-logged with timing, endpoint selected, errors, trace version.

## Mutations

Always `dry_run` first, ask user before `confirm_unsafe`:

```bash
# Preview
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {}, "dry_run": true}'

# Execute (after user confirms)
curl -s -X POST "$UNBROWSE/v1/skills/{skill_id}/execute" \
  -H "Content-Type: application/json" \
  -d '{"params": {}, "confirm_unsafe": true}'
```

## Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/intent/resolve` | Resolve intent → search/capture/execute |
| POST | `/v1/skills/:id/execute` | Execute a specific skill |
| POST | `/v1/auth/login` | Interactive browser login |
| POST | `/v1/feedback` | Submit feedback with diagnostics |
| GET | `/v1/sessions/:domain` | Debug session logs for domain |
| GET | `/v1/skills/:id` | Get skill details |
| POST | `/v1/search` | Search marketplace globally |
| POST | `/v1/search/domain` | Search marketplace by domain |
| POST | `/v1/skills/:id/issues` | Report broken skill |
| POST | `/v1/skills/:id/endpoints/:eid/recipe` | Submit extraction recipe |
| DELETE | `/v1/skills/:id/endpoints/:eid/recipe` | Remove extraction recipe |
| GET | `/health` | Health check + trace version |

## Rules

1. Always try `intent/resolve` first
2. Check the result — if wrong, pick from `available_endpoints` and re-execute
3. If `auth_required`, use `/v1/auth/login` then retry
4. Always `dry_run` before mutations
5. **Always submit feedback with diagnostics after every call — this is mandatory**
6. If something is slow or broken, check `/v1/sessions/:domain` before filing issues
7. Report broken skills via `/v1/skills/:id/issues`
8. If the response is deeply nested, submit an extraction recipe so future agents get clean data
