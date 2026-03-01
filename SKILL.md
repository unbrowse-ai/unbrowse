---
name: unbrowse
description: Analyze any website's network traffic and turn it into reusable API skills backed by a shared marketplace. Skills discovered by any agent are published, scored, and reusable by all agents. Capture network traffic, discover API endpoints, learn patterns, execute learned skills, and manage auth for gated sites. Use when someone wants to extract structured data from a website, discover API endpoints, automate web interactions, or work without official API documentation.
user-invocable: true
metadata: {"openclaw": {"requires": {"bins": ["bun"]}, "emoji": "🔍", "homepage": "https://github.com/unbrowse-ai/unbrowse"}}
---

# Unbrowse — Drop-in Browser Replacement for Agents

Browse once, cache the APIs, reuse them instantly. First call discovers and learns the site's APIs (~20-80s). Every subsequent call uses cached skills (<200ms for server-fetch, ~2s for sites requiring browser execution).

**IMPORTANT: Always use the CLI (`bun src/cli.ts`). NEVER pipe output to `node -e`, `python -c`, or `jq` — this causes shell escaping failures. Use `--path`, `--extract`, and `--limit` flags instead.**

## Server Startup

```bash
cd ~/.agents/skills/unbrowse && bun src/cli.ts health
```

If not running, the CLI auto-starts the server. First time requires ToS acceptance — ask the user:

> Unbrowse needs you to accept its Terms of Service:
> - Discovered API structures may be shared in the collective registry
> - You will not use Unbrowse to attack, overload, or abuse any target site
> Full terms: https://unbrowse.ai/terms

After consent, the CLI handles startup automatically. First run also needs the browser engine:

```bash
cd ~/.agents/skills/unbrowse && npx agent-browser install
```

## Core Workflow

### Step 1: Resolve an intent

```bash
cd ~/.agents/skills/unbrowse && bun src/cli.ts resolve \
  --intent "get feed posts" \
  --url "https://www.linkedin.com/feed/" \
  --pretty
```

This returns `available_endpoints` — a ranked list of discovered API endpoints. Pick the right one by URL pattern (e.g., `MainFeed` for feed, `HomeTimeline` for tweets).

### Step 2: Execute with extraction

```bash
cd ~/.agents/skills/unbrowse && bun src/cli.ts execute \
  --skill {skill_id} \
  --endpoint {endpoint_id} \
  --path "data.included[]" \
  --extract "author:actor.name.text,text:commentary.text.text,posted:actor.subDescription.text" \
  --limit 20 \
  --pretty
```

**This is the key pattern — `--path` + `--extract` + `--limit` replace ALL piping to jq/node/python.**

### Step 3: Submit feedback (MANDATORY)

```bash
cd ~/.agents/skills/unbrowse && bun src/cli.ts feedback \
  --skill {skill_id} \
  --endpoint {endpoint_id} \
  --rating 5 \
  --outcome success
```

**Rating:** 5=right+fast, 4=right+slow(>5s), 3=incomplete, 2=wrong endpoint, 1=useless.

## Data Extraction Flags

These flags eliminate the need to pipe output to any external parser:

| Flag | Example | What it does |
|------|---------|--------------|
| `--path` | `"data.home.timeline.instructions[].entries[]"` | Drill into nested response using dot-paths with `[]` array expansion |
| `--extract` | `"user:core.user.name,text:legacy.full_text"` | Pick specific fields with `alias:path` mapping |
| `--limit` | `10` | Cap array output to N items |
| `--pretty` | (boolean) | Indented JSON output |
| `--raw` | (boolean) | Skip extraction recipes, return unprocessed data |

When these flags are used, trace metadata is slimmed automatically (1MB raw -> 1.5KB output typical).

### Examples

```bash
# X timeline — extract tweets with user, text, likes
bun src/cli.ts execute --skill {id} --endpoint {id} \
  --path "data.home.home_timeline_urt.instructions[].entries[].content.itemContent.tweet_results.result" \
  --extract "user:core.user_results.result.legacy.screen_name,text:legacy.full_text,likes:legacy.favorite_count" \
  --limit 20 --pretty

# LinkedIn feed — extract posts from included[]
bun src/cli.ts execute --skill {id} --endpoint {id} \
  --path "data.included[]" \
  --extract "author:actor.name.text,text:commentary.text.text,likes:socialDetail.totalSocialActivityCounts.numLikes" \
  --limit 20 --pretty

# Simple case — just limit results
bun src/cli.ts execute --skill {id} --endpoint {id} --limit 10 --pretty
```

## Extraction Recipes

For responses you parse repeatedly, submit a recipe so future calls return clean data automatically (for ALL agents):

```bash
cd ~/.agents/skills/unbrowse && bun src/cli.ts recipe \
  --skill {skill_id} \
  --endpoint {endpoint_id} \
  --source "included" \
  --fields "author:actor.name.text,text:commentary.text.text,posted:actor.subDescription.text" \
  --require "commentary" \
  --compact \
  --description "Extract posts from LinkedIn feed"
```

When a recipe exists, future executions auto-return clean data. Use `--raw` to bypass recipes.

| Recipe flag | Description |
|-------------|-------------|
| `--source "path"` | Dot-path to the source array |
| `--fields "alias:path,..."` | Field mappings |
| `--filter '{"field":"type","equals":"post"}'` | Filter array items (JSON) |
| `--require "field1,field2"` | Required non-null fields |
| `--compact` | Strip nulls and empty values |

## Authentication

**Automatic.** Unbrowse extracts cookies from your Chrome/Firefox SQLite database — if you're logged into a site in Chrome, it just works.

If `auth_required` is returned:

```bash
cd ~/.agents/skills/unbrowse && bun src/cli.ts login --url "https://example.com/login"
```

User completes login in the browser window. Cookies are stored and reused automatically.

## Other Commands

```bash
bun src/cli.ts skills                                    # List all skills
bun src/cli.ts skill {id}                                # Get skill details
bun src/cli.ts search --intent "..." --domain "..."      # Search marketplace
bun src/cli.ts sessions --domain "linkedin.com"          # Debug session logs
bun src/cli.ts health                                    # Server health check
```

## Mutations

Always `--dry-run` first, ask user before `--confirm-unsafe`:

```bash
bun src/cli.ts execute --skill {id} --endpoint {id} --dry-run
bun src/cli.ts execute --skill {id} --endpoint {id} --confirm-unsafe
```

## REST API Reference

For cases where the CLI doesn't cover your needs, the raw REST API is at `http://localhost:6969`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/intent/resolve` | Resolve intent -> search/capture/execute |
| POST | `/v1/skills/:id/execute` | Execute a specific skill |
| POST | `/v1/auth/login` | Interactive browser login |
| POST | `/v1/feedback` | Submit feedback with diagnostics |
| POST | `/v1/search` | Search marketplace globally |
| POST | `/v1/search/domain` | Search marketplace by domain |
| POST | `/v1/skills/:id/endpoints/:eid/recipe` | Submit extraction recipe |
| GET | `/v1/skills/:id` | Get skill details |
| GET | `/v1/sessions/:domain` | Debug session logs |
| GET | `/health` | Health check |

## Rules

1. **Always use the CLI** — never pipe to `node -e`, `python -c`, or `jq`. Use `--path`/`--extract`/`--limit` instead.
2. Always try `resolve` first — it handles the full marketplace search -> capture pipeline
3. Check the result — if wrong, pick from `available_endpoints` and re-execute with `--endpoint`
4. If `auth_required`, use `login` then retry
5. Always `--dry-run` before mutations
6. **Always submit feedback after every resolve call — this is mandatory**
7. If the response is deeply nested, submit a recipe so future agents get clean data
8. **Report bugs and issues on GitHub** — when something breaks, is slow, or behaves unexpectedly, file an issue:
   ```bash
   gh issue create --repo unbrowse-ai/unbrowse \
     --title "bug: {short description}" \
     --body "## What happened\n{description}\n\n## Expected\n{what should have happened}\n\n## Context\n- Skill: {skill_id}\n- Endpoint: {endpoint_id}\n- Domain: {domain}\n- Error: {error message or status code}"
   ```
   Categories: `bug:` (broken/wrong data), `perf:` (slow), `auth:` (login/cookie issues), `feat:` (missing capability)
