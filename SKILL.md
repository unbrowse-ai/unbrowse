---
name: unbrowse
description: >-
  DEPRECATED. The Anthropic skill path for Unbrowse has been retired as of
  v6.14.0. Use the MCP server instead — it is the supported integration
  surface. See instructions below.
user-invocable: true
metadata: {"openclaw": {"requires": {"bins": ["unbrowse"]}, "install": [{"id": "npm", "kind": "node", "package": "unbrowse", "bins": ["unbrowse"]}], "emoji": "🔍", "homepage": "https://github.com/unbrowse-ai/unbrowse", "deprecated": true, "replacement": "mcp"}}
---

# Unbrowse — Skill Deprecated, Use MCP

> **This skill is deprecated as of Unbrowse v6.14.0.** The supported integration is the MCP server. The standalone CLI (`unbrowse ...`) continues to work and is unaffected.

## Migrate to MCP (one config block)

Add this to your MCP host config (Claude Desktop, Cursor, Codex, or any MCP-compatible client):

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse", "mcp"]
    }
  }
}
```

Then run once on the host machine:

```bash
npx unbrowse setup
```

That bootstraps the local runtime, accepts ToS, registers an agent identity, and pairs your wallet for x402 earnings.

## Why this changed

The skill path put a long policy + CLI document into the agent's context window on every invocation. The MCP server exposes the same capabilities as discoverable tools with structured schemas and result-size caps (25 KB), so agents get the right shape without paying for the prose. The MCP tools are also versioned per release, where the skill was a frozen blob.

## What MCP gives you

Discovery + execute:

- `unbrowse_resolve` — given an intent + URL, return a ranked endpoint shortlist with schema, sample values, params, and `next_step` hints.
- `unbrowse_execute` — call a chosen endpoint with `path` / `extract` / `limit` projection. Result is wire-capped at 25 KB.
- `unbrowse_feedback` — required after every execute.
- `unbrowse_search` — search the marketplace by intent + domain.
- `unbrowse_skills`, `unbrowse_skill` — list and inspect cached skills.

Browse session (when resolve has no skill yet):

- `unbrowse_go`, `unbrowse_snap`, `unbrowse_click`, `unbrowse_fill`, `unbrowse_type`, `unbrowse_press`, `unbrowse_select`, `unbrowse_scroll`, `unbrowse_submit`, `unbrowse_eval`, `unbrowse_screenshot`, `unbrowse_text`, `unbrowse_markdown`, `unbrowse_cookies`, `unbrowse_sync`, `unbrowse_close`.

Settings + review + publish:

- `unbrowse_settings` — toggle `share_pointers`, configure capture pipeline.
- `unbrowse_review`, `unbrowse_publish` — review captured endpoints and publish to the marketplace.
- `unbrowse_health` — server health check.

Workflow resources + prompts (read-only): `workflow_publish://<skill>`, `workflow_contract://<skill>/<endpoint>`, `workflow_dag://<skill>/<endpoint>`, and the `plan_workflow_execution` prompt.

## CLI is not deprecated

The `unbrowse` CLI is the same binary that backs the MCP server. It remains supported for shell use, scripts, and CI. Only the skill path (this file, shipped via `unbrowse-ai/unbrowse`) is deprecated.

<!-- CLI_REFERENCE_START -->
## CLI Flags

**Auto-generated from `src/cli.ts CLI_REFERENCE` — do not edit manually. Run `bun scripts/sync-skill-md.ts` to sync.**

### Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `setup` | `[--opencode auto|global|project|off] [--no-start] [--skip-browser]` | Bootstrap browser engine + write the /unbrowse Open Code command. Run once on install. Idempotent. |
| `upgrade` |  | Print the right upgrade command (npm i -g unbrowse@latest or @preview). |
| `health` |  | Quick local server health check. Returns version + uptime. |
| `mcp` | `[--no-auto-start]` | Run the stdio MCP server. Used by Claude/Cursor; not for direct shell use. |
| `account` | `[--register] [--email user@example.com] [--reset-key] [--json]` | Show local account, wallet, and contribution mode. --register mints a new key (replaces old `register` command). |
| `mode` |  | Re-prompt for contribution mode: private / share / share + earn (changes whether captured skills go to the marketplace). |
| `dashboard` | `[--no-open]` | Open the website dashboard and pair this CLI install through localhost. |
| `settings` | `[--auto-publish on|off] [--publish-blacklist d1,d2] [--publish-promptlist d1,d2]` | Show or update local capture/publish policy (per-domain allow/block lists). |
| `fetch` | `<url> [opts] | <url> --bundle-source <js|-> --post-eval <expr> [opts]` | PRIMARY URL → content tool. SIMPLE mode (`fetch <url>`) prints body only, HTML auto-converted to markdown. ADVANCED mode (with --bundle-source) runs custom JS in a Kuri sandbox and prints the full envelope (cookies, post_eval, observed routes). All requests go through libcurl-impersonate (Chrome 131 JA4) and auto-pull cookies from your real browser. |
| `run` | `<url> "task"` | One-shot agent path. Chooses direct cached/API replay first, captures+indexes on miss, retries, then opens browser only when interaction is needed. Accepts positional task text or --intent/--task/--query. |
| `resolve` | `--intent "..." [--url "..."] [--domain "..."] [--no-execute]` | Advanced: resolve an intent against marketplace + local cache only. --task and --query are accepted aliases for --intent. Auto-executes the top safe GET endpoint by default; --no-execute returns metadata only. |
| `execute` | `--skill ID --endpoint ID [-p key=val ...] [--params '{json}']` | Execute a specific endpoint. Call after `unbrowse resolve --no-execute` returned a shortlist. Pass replay params via repeated -p flags or --params with a JSON object. |
| `explain` | `--intent "..." --url "..." [--top N]` | Print top-N candidate endpoints + evidence so an LLM (or you) can pick. No heuristic verdict — just primitives + evidence. |
| `capture` | `--url <url> --intent <intent> [--retries N]  |  --corpus <file> --out <file> [--retries N]` | Advanced: live-browser HAR capture; discovers + indexes API endpoints. `run` calls this automatically on misses. Marketplace publish gated by `unbrowse mode`. |
| `auth` | `<url>` | Open a visible browser so you can sign in to a site; cookies persist for future run/fetch/resolve. (Old names: `auth-capture`, `login`.) |
| `note` | `<read|write|list> --domain <domain> [--body "..."]` | Per-domain LLM-prose notes consumed by augment on next capture. Populate after reading capture's note_evidence. |
| `skills` |  | List all locally-cached skills (skill_id, domain, endpoint count). |
| `skill` | `<id>` | Get full SkillManifest for one skill (intent, endpoints, schemas). |
| `feedback` | `--skill ID --endpoint ID --rating 1-5` | Submit feedback after presenting endpoint results to the user (mandatory after resolve+execute). |
| `annotate` | `--skill ID --endpoint ID --text 'tip' [--constraint 'param:rule:msg']` | Contribute best practices, constraints, or gotchas for an endpoint. |
| `review` | `--skill ID --endpoints '[...]'` | Push reviewed descriptions/schema metadata back to a captured skill before publish. |
| `index` | `--skill ID` | Recompute local graph/contracts/export from cached skill state. Cheap; doesn't hit the network. |
| `publish` | `--skill ID [--confirm-publish] [--endpoints '[...]']` | Publish reviewed skill to the marketplace. Re-indexes locally first; --confirm-publish bypasses the safety prompt. |
| `publish-bundle` | `--preset path [--hosts codex,claude,openclaw] [--site-url url]` | Derive foundry bundle/share/host artifacts from one preset and write the public share manifest. |
| `cleanup-stale` | `[--skill ID] [--domain host] [--limit N]` | Verify skills against live endpoints and evict stale cached entries. |
| `go` | `<url> [--session id]` | Open a fresh Kuri browser tab (or reuse via --session). Step 1 of the browse workflow. |
| `snap` | `[--session id] [--filter interactive]` | A11y snapshot with @eN refs. Inspect the page state — gives you the refs to click/fill. |
| `click` | `[--session id] <ref>` | Click element by @eN ref from snap. |
| `fill` | `[--session id] <ref> <value>` | Fill input by @eN ref with the given value. |
| `type` | `<text>` | Type into the focused element with key events (use after click). |
| `press` | `<key>` | Press a key (Enter, Tab, Escape, ArrowDown, ...). |
| `select` | `<ref> <value>` | Select option by @eN ref + value (for <select> elements). |
| `scroll` | `[up|down|left|right]` | Scroll the page in a direction. |
| `submit` | `[--session id] [--form-selector sel] [--submit-selector sel] [--wait-for hint]` | Submit current form. Browser-native by default; site-state assist + same-origin rehydrate are explicit opt-ins. |
| `screenshot` | `[--session id]` | Capture screenshot (base64 PNG). |
| `text` | `[--session id]` | Get page text content. |
| `markdown` | `[--session id]` | Get page as Markdown. |
| `cookies` | `[--session id]` | Get page cookies. |
| `eval` | `[--session id] <expression>` | Evaluate JavaScript in the page context (e.g. inspect hidden inputs, read JS state). |
| `back` | `[--session id]` | Browser back. |
| `forward` | `[--session id]` | Browser forward. |
| `sync` | `[--session id]` | Checkpoint capture, keep tab open, queue background index + publish. |
| `close` | `[--session id]` | Final checkpoint, queue background index + publish, close session. End-of-flow. |
| `inspect` | `[--session id] [--all]` | Inspect live capture evidence, candidate endpoints, and next actions for the active session. |
| `sessions` | `--domain "..." [--limit N]` | List recent session logs for a domain (debug). |
| `stats` | `[--flywheel | --earnings] [--json]` | Lifetime time/tokens/cost saved + marketplace earnings. --flywheel for funnel/index health view, --earnings for credits view. (Replaces separate `flywheel` and `earnings` commands.) |

### Global flags

| Flag | Description |
|------|-------------|
| `--pretty` | Pretty-print JSON output (indented). |
| `--no-auto-start` | Don't auto-spawn the local server if it's down. |
| `--raw` | Skip post-processing. On fetch: keep HTML/JSON bytes (no markdown). On resolve/execute: skip server-side projection. |
| `--skip-browser` | setup: skip browser-engine install. |
| `--opencode auto|global|project|off` | setup: install /unbrowse command for Open Code. |

### resolve/execute flags

| Flag | Description |
|------|-------------|
| `--no-execute` | Resolve only; return shortlist without auto-executing. |
| `--schema` | Show response schema + extraction hints (no data). |
| `--path "data.items[]"` | Drill into the result before extract/output. |
| `--extract "field1,alias:deep.path"` | Pick specific fields (no piping). |
| `--limit N` | Cap array output to N items. |
| `--endpoint ID` | Pick a specific endpoint by ID. (Alias: --endpoint-id.) |
| `--dry-run` | Preview mutations without applying. |
| `--params '{...}'` | Extra params as JSON. |
| `-p key=val` | Single param via repeated flag (alternative to --params JSON). |
| `--require-proof` | Filter resolve to only endpoints with independently verified proofs. |
<!-- CLI_REFERENCE_END -->

## Sunset timeline

- v6.14.0 (this release): skill path marked deprecated; loaders should warn.
- One minor cycle (v6.15.x): critical fixes only on the skill repo.
- After that: skill repo archived; the README will redirect to the MCP install path.

## Help

- Repo: https://github.com/unbrowse-ai/unbrowse
- Docs: https://unbrowse.ai
- Issues: https://github.com/unbrowse-ai/unbrowse/issues
