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

**Auto-extraction:** When the response is large (>2KB) and the engine has high confidence in the data structure, it **auto-extracts** structured data — you get clean results immediately with `_auto_extracted` metadata showing what was applied. No second call needed.

If auto-extraction fires, the response includes:
- `result` — already extracted, clean data (array of objects with useful fields)
- `_auto_extracted.applied` — the `--path`/`--extract` that was auto-applied
- `_auto_extracted.all_fields` — schema tree showing ALL available fields if you need different ones
- `_auto_extracted.note` — how to customize (add `--extract` to override field selection)

### Step 2: Refine extraction (only if needed)

**If auto-extraction returned what you need, skip to Step 3.** Otherwise, customize:

```bash
# Override fields — use _auto_extracted.all_fields to see what's available
cd ~/.agents/skills/unbrowse && bun src/cli.ts execute \
  --skill {skill_id} \
  --endpoint {endpoint_id} \
  --path "data.events[]" \
  --extract "name,url,start_at,price" \
  --limit 10 --pretty

# See full schema without data
cd ~/.agents/skills/unbrowse && bun src/cli.ts execute \
  --skill {skill_id} \
  --endpoint {endpoint_id} \
  --schema --pretty

# Get raw unprocessed response
cd ~/.agents/skills/unbrowse && bun src/cli.ts execute \
  --skill {skill_id} \
  --endpoint {endpoint_id} \
  --raw --pretty
```

**`--path` + `--extract` + `--limit` replace ALL piping to jq/node/python.**

### Step 3: Submit feedback (MANDATORY)

```bash
cd ~/.agents/skills/unbrowse && bun src/cli.ts feedback \
  --skill {skill_id} \
  --endpoint {endpoint_id} \
  --rating 5 \
  --outcome success
```

**Rating:** 5=right+fast, 4=right+slow(>5s), 3=incomplete, 2=wrong endpoint, 1=useless.

<!-- CLI_REFERENCE_START -->
## CLI Flags

**Auto-generated from `src/cli.ts CLI_REFERENCE` — do not edit manually. Run `bun scripts/sync-skill-md.ts` to sync.**

### Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `health` |  | Server health check |
| `resolve` | `--intent "..." --url "..." [opts]` | Resolve intent → search/capture/execute |
| `execute` | `--skill ID --endpoint ID [opts]` | Execute a specific endpoint |
| `feedback` | `--skill ID --endpoint ID --rating N` | Submit feedback (mandatory after resolve) |
| `login` | `--url "..."` | Interactive browser login |
| `skills` |  | List all skills |
| `skill` | `<id>` | Get skill details |
| `search` | `--intent "..." [--domain "..."]` | Search marketplace |
| `sessions` | `--domain "..." [--limit N]` | Debug session logs |

### Global flags

| Flag | Description |
|------|-------------|
| `--pretty` | Indented JSON output |
| `--no-auto-start` | Don't auto-start server |
| `--raw` | Return raw response data (skip server-side projection) |

### resolve/execute flags

| Flag | Description |
|------|-------------|
| `--schema` | Show response schema + extraction hints only (no data) |
| `--path "data.items[]"` | Drill into result before extract/output |
| `--extract "field1,alias:deep.path.to.val"` | Pick specific fields (no piping needed) |
| `--limit N` | Cap array output to N items |
| `--endpoint-id ID` | Pick a specific endpoint |
| `--dry-run` | Preview mutations |
| `--force-capture` | Bypass caches, re-capture |
| `--params '{...}'` | Extra params as JSON |
<!-- CLI_REFERENCE_END -->

When `--path`/`--extract` are used, trace metadata is slimmed automatically (1MB raw -> 1.5KB output typical).

When NO extraction flags are used on a large response (>2KB), the CLI auto-wraps the result with `extraction_hints` instead of dumping raw data. This prevents context window bloat and tells you exactly how to extract. Use `--raw` to override this and get the full response.

### Examples

```bash
# Step 1: resolve — auto-executes and returns hints for complex responses
bun src/cli.ts resolve --intent "get events" --url "https://lu.ma" --pretty
# Response includes extraction_hints.cli_args = "--path \"data.events[]\" --extract \"name,url,start_at,city\" --limit 10"

# Step 2: use the hints directly
bun src/cli.ts execute --skill {id} --endpoint {id} \
  --path "data.events[]" --extract "name,url,start_at,city" --limit 10 --pretty

# If you need to see the schema first
bun src/cli.ts execute --skill {id} --endpoint {id} --schema --pretty

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
| GET | `/v1/skills/:id` | Get skill details |
| GET | `/v1/sessions/:domain` | Debug session logs |
| GET | `/health` | Health check |

## Rules

1. **Always use the CLI** — never pipe to `node -e`, `python -c`, or `jq`. Use `--path`/`--extract`/`--limit` instead.
2. Always try `resolve` first — it handles the full marketplace search -> capture pipeline
3. **Trust auto-extraction** — for large responses, the CLI auto-extracts structured data using `response_schema`. Check `_auto_extracted` in the response to see what was applied. If the result looks right, you're done. If you need different fields, use `_auto_extracted.all_fields` to see what's available and re-run with `--extract`.
4. **NEVER guess paths by trial-and-error** — use `--schema` to see the full response structure, or read `_auto_extracted.all_fields` / `extraction_hints.schema_tree`
5. Use `--raw` if you need the unprocessed full response
6. Check the result — if wrong endpoint, pick from `available_endpoints` and re-execute with `--endpoint`
7. If `auth_required`, use `login` then retry
8. Always `--dry-run` before mutations
9. **Always submit feedback after every resolve call — this is mandatory**
10. **Report bugs and issues on GitHub** — when something breaks, is slow, or behaves unexpectedly, file an issue:
   ```bash
   gh issue create --repo unbrowse-ai/unbrowse \
     --title "bug: {short description}" \
     --body "## What happened\n{description}\n\n## Expected\n{what should have happened}\n\n## Context\n- Skill: {skill_id}\n- Endpoint: {endpoint_id}\n- Domain: {domain}\n- Error: {error message or status code}"
   ```
   Categories: `bug:` (broken/wrong data), `perf:` (slow), `auth:` (login/cookie issues), `feat:` (missing capability)
