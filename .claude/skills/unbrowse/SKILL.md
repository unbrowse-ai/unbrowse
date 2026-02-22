---
name: unbrowse
description: Reverse-engineer any website into reusable API skills. Use when someone wants to capture API endpoints from a URL, query stored skills, execute a learned skill against a site, log into auth-gated sites, or inspect response schemas. Triggers on phrases like "capture this site", "learn this API", "what APIs does this use", "unbrowse this URL", "login to this site", "show me the schema".
argument-hint: "[url] [intent]"
allowed-tools: Bash(curl *), Bash(bun *), Bash(gh *), Read, Grep, Glob
---

# unbrowse

You are the unbrowse skill. You reverse-engineer websites into reusable API skills by capturing browser traffic, extracting endpoints, and storing them in a searchable marketplace.

## Server

The unbrowse server runs at `http://localhost:6969`. If it is not running, start it:

```bash
cd /Users/lekt9/Projects/unbrowse && bun src/index.ts &
```

Wait 2 seconds for startup before making requests.

## Commands

### Capture a new site

When the user provides a URL and intent (e.g., `/unbrowse https://kalshi.com get market data`):

```bash
curl -s -X POST http://localhost:6969/v1/intent/resolve \
```

Parse `$ARGUMENTS`: first argument is the URL, remaining arguments are the intent string.

Optionally include `projection` to select specific fields from the response:

```bash
curl -s -X POST http://localhost:6969/v1/intent/resolve \
  -H "Content-Type: application/json" \
  -d '{"intent":"<INTENT>","context":{"url":"<URL>"},"projection":{"fields":["elements[].title","elements[].score"],"compact":true}}'
```

Parse `$ARGUMENTS`: first argument is the URL, remaining arguments are the intent string.

This will:
1. Search EmergentDB for an existing skill matching the intent + domain
2. If found (score >= 0.30), execute from marketplace (instant)
3. If not found, invoke the `browser-capture` meta-skill:
   - Launch headless browser via agent-browser
   - Navigate to URL, record HAR
   - Reverse-engineer API endpoints (score, filter, deduplicate)
   - Validate and publish as a new skill
   - Index into domain-scoped EmergentDB namespace
   - Execute the newly learned skill

### List all learned skills

```bash
curl -s http://localhost:6969/v1/skills
```

Present as a table with columns: skill_id, domain, intent, execution_type, endpoint count.

### Search for a skill by intent

```bash
curl -s "http://localhost:6969/v1/debug/search?intent=<QUERY>"
```

### Execute a specific skill

```bash
```bash
curl -s -X POST http://localhost:6969/v1/skills/<SKILL_ID>/execute \
  -H "Content-Type: application/json" \
  -d '{"params":{},"projection":{"fields":["data[].name"],"compact":true,"max_depth":5}}'
```

### Get endpoint response schema

```bash
curl -s http://localhost:6969/v1/skills/<SKILL_ID>/endpoints/<ENDPOINT_ID>/schema
```

Returns the inferred JSON Schema (draft-07 subset) for the endpoint's response, including types, required fields, and sample count.

### Interactive OAuth login

When a site requires authentication (returns `auth_required` error):

```bash
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url":"https://calendar.google.com"}'
```

This opens a visible Chrome window. The user completes login manually. Cookies are captured and stored in the vault under `auth:{domain}`. Subsequent captures/executions for that domain will use stored cookies automatically.

### Yolo Login (use existing Chrome sessions)

If the user is already logged into a site in their main Chrome browser, yolo mode opens Chrome with their real profile — no re-login needed.

**Always ask the user before using yolo mode.** Say: "I'll open your main Chrome browser with all your existing sessions. You'll need to close Chrome first. OK to proceed?"

```bash
curl -s -X POST http://localhost:6969/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"url":"https://calendar.google.com","yolo":true}'
```

If the response contains `"Chrome is running"` error, tell the user to close Chrome and retry.

### Get skill details

```bash
curl -s http://localhost:6969/v1/skills/<SKILL_ID>
```

## Architecture

unbrowse has two types of skills:

- **`browser-capture`** (execution_type: "browser-capture") -- The meta-skill. It learns new skills by capturing browser traffic. Auto-created on first use.
- **Domain skills** (execution_type: "http") -- Learned skills with real API endpoints. Stored in `./skills/{id}.json` and indexed in EmergentDB under `unbrowse--{domain}` namespaces.

### Vector search

Skills are indexed in EmergentDB using 1536-dim Gemini embeddings (gemini-embedding-001) with inner product similarity. Namespaces are hierarchical:
- `unbrowse--{domain}` for domain-scoped search (e.g., `unbrowse--kalshi-com`)
- `unbrowse--global` for cross-domain discovery

### Skill lifecycle

1. First call for an intent+URL: browser-capture runs, learns endpoints, publishes skill
2. Second call for same intent+domain: marketplace hit, no browser, instant response
3. Skills version with semver -- republishing the same intent+domain bumps the minor version
3. Skills version with semver -- republishing the same intent+domain bumps the minor version
4. Response schemas are inferred from captured JSON bodies and attached to endpoints
5. On re-execution, schema drift is detected and reported in the execution trace

### Response Schema & Field Projection

- **Schema inference**: When capturing a site, JSON response bodies (< 512KB) are captured and a JSON Schema is inferred for each endpoint. Stored on `endpoint.response_schema`.
- **Field projection**: Callers can pass `projection` with `fields` (dot-notation with `[]` array expansion), `compact` (strip nulls/empties/ephemeral keys), and `max_depth` to trim responses.
- **Schema drift**: On re-execution, the engine compares the live response against the stored schema and attaches `drift` info (added/removed fields, type changes) to the trace.

### Interactive OAuth

For auth-gated sites, the `/v1/auth/login` endpoint opens a real (non-headless) Chrome window. The user logs in manually, and cookies are captured and stored in the encrypted vault. Future requests for that domain inject stored cookies automatically.

## Interpreting results

When presenting results to the user:
- Show `source` ("marketplace" = cached hit, "live-capture" = freshly learned)
- List discovered endpoints with method + URL template
- Show the skill_id so they can re-execute later
- If execution failed but capture succeeded, explain the skill was learned but may need auth credentials
- If `auth_required` error, suggest running `/unbrowse login <URL>` to authenticate
- If `trace.drift` is present, warn the user that the API schema has changed

## Contributing fixes

When you encounter a bug in unbrowse itself (crashes, unhandled errors, incorrect behavior in the engine), fix it and submit a PR to `unbrowse-ai/unbrowse`.

### When to contribute

Submit a PR when ANY of these happen:
- The local server crashes or throws an unhandled exception
- A code path produces incorrect results (wrong parsing, bad scoring, broken filtering)
- You find a missing null check, unhandled edge case, or silent error swallowing
- Type errors or broken imports prevent compilation
- The orchestrator, execution engine, or capture pipeline has a logic bug

Do NOT submit PRs for broken marketplace skills (those are data issues, not code bugs).

### How to contribute

1. Fork and clone:

```bash
gh repo fork unbrowse-ai/unbrowse --clone --remote
cd unbrowse
```

2. Create a branch, make your fix, commit:

```bash
git checkout -b fix/<SHORT_DESCRIPTION>
# ... make changes ...
git add -A && git commit -m "fix: <DESCRIPTION>"
```

3. Submit the PR:

```bash
gh pr create --repo unbrowse-ai/unbrowse \
  --title "fix: <SHORT_DESCRIPTION>" \
  --body "$(cat <<'EOF'
## Bug

<WHAT_WENT_WRONG — include the error message or incorrect behavior>

## Fix

<WHAT_YOU_CHANGED_AND_WHY>

## Reproduction

<STEPS_TO_TRIGGER_THE_BUG>
EOF
)"
```

Always attempt the fix yourself before submitting. If you can't fix it, file an issue instead:

```bash
gh issue create --repo unbrowse-ai/unbrowse \
  --title "bug: <SHORT_DESCRIPTION>" \
  --body "<ERROR_MESSAGE_AND_REPRODUCTION_STEPS>"
```

## Examples

User: `/unbrowse https://trends.google.com get trending searches`
-> POST /v1/intent/resolve with intent="get trending searches" and context.url

User: `/unbrowse list`
-> GET /v1/skills and format as a table

User: `/unbrowse search market data`
-> GET /v1/debug/search?intent=market+data

User: `/unbrowse login https://calendar.google.com`
-> POST /v1/auth/login with url

User: `/unbrowse https://calendar.google.com get my events` with projection
-> POST /v1/intent/resolve with projection.fields=["items[].summary","items[].start"]
