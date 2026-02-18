---
name: unbrowse
description: Reverse-engineer any website into reusable API skills. Use when someone wants to capture API endpoints from a URL, query stored skills, or execute a learned skill against a site. Triggers on phrases like "capture this site", "learn this API", "what APIs does this use", "unbrowse this URL".
argument-hint: "[url] [intent]"
allowed-tools: Bash(curl *), Bash(bun *), Read, Grep, Glob
---

# unbrowse

You are the unbrowse skill. You reverse-engineer websites into reusable API skills by capturing browser traffic, extracting endpoints, and storing them in a searchable marketplace.

## Server

The unbrowse server runs at `http://localhost:3000`. If it is not running, start it:

```bash
cd /Users/rachpradhan/unbrowse && bun src/index.ts &
```

Wait 2 seconds for startup before making requests.

## Commands

### Capture a new site

When the user provides a URL and intent (e.g., `/unbrowse https://kalshi.com get market data`):

```bash
curl -s -X POST http://localhost:3000/v1/intent/resolve \
  -H "Content-Type: application/json" \
  -d '{"intent":"<INTENT>","context":{"url":"<URL>"}}'
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
curl -s http://localhost:3000/v1/skills
```

Present as a table with columns: skill_id, domain, intent, execution_type, endpoint count.

### Search for a skill by intent

```bash
curl -s "http://localhost:3000/v1/debug/search?intent=<QUERY>"
```

### Execute a specific skill

```bash
curl -s -X POST http://localhost:3000/v1/skills/<SKILL_ID>/execute \
  -H "Content-Type: application/json" \
  -d '{"params":{}}'
```

### Get skill details

```bash
curl -s http://localhost:3000/v1/skills/<SKILL_ID>
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

## Interpreting results

When presenting results to the user:
- Show `source` ("marketplace" = cached hit, "live-capture" = freshly learned)
- List discovered endpoints with method + URL template
- Show the skill_id so they can re-execute later
- If execution failed but capture succeeded, explain the skill was learned but may need auth credentials

## Examples

User: `/unbrowse https://trends.google.com get trending searches`
-> POST /v1/intent/resolve with intent="get trending searches" and context.url

User: `/unbrowse list`
-> GET /v1/skills and format as a table

User: `/unbrowse search market data`
-> GET /v1/debug/search?intent=market+data
