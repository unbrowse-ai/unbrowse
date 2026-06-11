---
name: unbrowse
description: Capture once, replay everywhere. Unbrowse turns websites into reusable, indexed API routes for agents. Resolve an intent + URL to a ranked endpoint shortlist, execute the chosen endpoint for real data, or open a managed browser when capture is needed. The default agent flow is exactly two calls (resolve then execute), typically 30x faster and 90x cheaper than a fresh browser session. Available as an MCP server, CLI, and SDK. Use when an agent needs live data or actions from a website, when a browser/scraper call could be replaced by a cached route, or when the user asks to capture, replay, or automate a site.
metadata:
  type: integration
  origin: unbrowse-ai/unbrowse
---

# Unbrowse

Unbrowse turns websites into reusable API routes for agents. Teach a route once, store
sanitized route metadata, replay it on later calls. A typical replay is about 30x faster
and 90x cheaper than a fresh browser session (peer-reviewed benchmark across 94 live
domains: 3.6x mean speedup, 5.4x median, 40x fewer tokens; arXiv:2604.00694).

## The agent contract (load-bearing): two calls, not one, not three

Every task uses the same shape. Do not collapse it to one call, do not pad it to three.

1. **resolve** answers "is there an indexed route for this intent + URL?" It returns a
   ranked shortlist of endpoints (you, the calling model, pick one) OR a handoff telling
   you to open a browser because nothing is indexed yet.
2. **execute** runs the one endpoint you picked from the shortlist and returns the real
   data.
3. **browse-session** (go) is the escalation: when resolve hands off, open a managed
   browser, drive it, and local capture indexes the route so the next caller skips
   straight to resolve+execute.

Read the shortlist, pick the best endpoint, execute it. When a call cannot complete, the
response carries an honest `next_step` field (for example `open_browse_session`,
`auth_required`, `abandon_or_authenticate`) instead of a bare error. Follow the
`next_step`; do not retry the same call blindly.

## Surfaces (pick one, same runtime underneath)

| Surface | Reach for it when |
|---|---|
| MCP server | An MCP-host agent (Claude Code, Claude Desktop, Cursor, Codex, Windsurf). The tools below appear in the host. |
| CLI (`unbrowse`) | A shell or script wanting the same surface without an MCP host. |
| SDK (`@unbrowse/sdk`) | A TypeScript program embedding Unbrowse; it spawns its own local binary. |

## MCP tools, grouped by what you are doing

- **Resolve + run a route (the common path):** `unbrowse_resolve` (intent + URL -> ranked
  shortlist), `unbrowse_execute` (run one endpoint from the shortlist), `unbrowse_run`
  (one-shot: resolve and run in a single call when you trust the top route),
  `unbrowse_search` (find a route or a web answer for an intent), `unbrowse_fetch` (fetch
  one URL to clean content when you just want the page).
- **Drive a browser when capture is needed:** `unbrowse_go` (open/reuse a tab),
  `unbrowse_snap` (accessibility snapshot with @eN refs), `unbrowse_click` /
  `unbrowse_fill` / `unbrowse_type` / `unbrowse_press` (act on @eN refs), `unbrowse_text`
  / `unbrowse_markdown` / `unbrowse_eval` (read the page), `unbrowse_sync` (checkpoint and
  index mid-flow), `unbrowse_close` (final checkpoint, index, close).
- **Auth:** `unbrowse_auth_capture` opens a visible browser so the user signs in once;
  cookies persist for later resolve/execute/fetch on that domain.

## Quickstart

MCP host:

```json
{ "mcpServers": { "unbrowse": { "command": "npx", "args": ["-y", "unbrowse", "mcp"] } } }
```

Then once: `npx unbrowse setup`

Shell:

```bash
unbrowse resolve --intent "search hacker news for openai" --url https://news.ycombinator.com
unbrowse execute --skill-id <id-from-resolve> --endpoint-id <id-from-shortlist>
```

Node:

```typescript
import { spawn } from '@unbrowse/sdk';
const client = await spawn();
const resolved = await client.resolve({ intent: 'search hn for openai', url: 'https://news.ycombinator.com' });
const result = await client.execute({ skillId: resolved.skill.id, endpointId: resolved.endpoints[0].id });
```

## How resolve decides (the fallback ladder)

A resolve request carries an intent + URL. The runtime tries, in order: a cached route ->
the shared route marketplace -> a fast first-pass fetch -> a live browser capture. Each
step appends one row to a trace. The response carries that trace with `success`,
`skill_id`, and `endpoint_id` as the proof of what actually ran. Unresolvable work
surfaces as a `next_step` field, never a silent failure.

## Hard rules

1. Two calls for a known route (resolve then execute); never one, never three.
2. When resolve hands off, follow the `next_step` (usually open a browse session); do not
   loop the same resolve.
3. Pick the endpoint from the shortlist yourself; the shortlist is structured for the
   model to choose, not for the runtime to guess.
4. A priced route is paid from the agent wallet or sponsored credit at execute time; a
   `402` response means payment is required, not that the route is broken.

## What this skill does NOT do

- It is not a general browser-automation framework; the browse tools exist to capture a
  route, then you replay it via resolve + execute.
- It does not scrape blindly; if no route resolves and capture is declined, it returns a
  `next_step`, not fabricated data.
- It does not store secrets in route metadata; captured routes are sanitized
  (pointer-not-payload), and credential fields are never persisted in the route.

## Public docs

Every primitive Unbrowse depends on (sanitized route metadata, residential proxy
fallback, interstitial shortcut, x402 payment, domain opt-out, fair revenue split, deploy
gate, benchmark harness) is documented under `docs/public/primitives/` in the public repo,
kept in sync by `scripts/check-primitives-doc-public.sh`.

## Provenance

Source: <https://github.com/unbrowse-ai/unbrowse-dev>
Public mirror: <https://github.com/unbrowse-ai/unbrowse>
MCP server, CLI, and SDK are published from this monorepo. `packages/skill/` is this
package: the npm-published CLI binary plus the skill manifest you are reading.
