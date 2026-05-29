---
name: unbrowse
description: Capture once, replay everywhere — Unbrowse learns reusable route metadata from allowed browsing sessions and replays it as a fast, cheap, indexed route. Brings back the skill surface alongside the MCP server + SDK + CLI.
metadata:
  type: integration
  origin: unbrowse-ai/unbrowse
---

# Unbrowse

Unbrowse turns websites into reusable API routes for agents. Teach a route once, store sanitized metadata, replay it on later calls. Typical run is 30× faster and 90× cheaper than a fresh browser session — peer-reviewed benchmark across 94 live domains: 3.6× mean speedup, 5.4× median, 40× fewer tokens ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694)).

Four surfaces, one runtime:

| Surface | When to reach for it |
|---|---|
| **MCP server** | An MCP-host agent (Claude Desktop, Cursor, Codex, Claude Code). Tool calls like `unbrowse_resolve`, `unbrowse_execute`, `unbrowse_go` appear in the host. |
| **CLI** (`unbrowse`) | A shell session or a bash-script that wants the same surface as the MCP server, without an MCP host. |
| **SDK** (`@unbrowse/sdk`) | A TypeScript program that wants to embed Unbrowse. `npm i @unbrowse/sdk` is enough; the SDK spawns its own local binary. |
| **Drop-in shims** | One-line replace for existing tools: `@unbrowse/playwright-shim`, `@unbrowse/firecrawl-shim`, `@unbrowse/stagehand-shim`. Cache hit → free; miss → fall through to the original library. |

All four resolve to the same runtime workflow underneath:
- **resolve** asks "is there an indexed route for this intent + URL?" — returns a shortlist or a hard handoff.
- **execute** picks one endpoint from the shortlist and runs it — returns the real data.
- **browse-session** opens a managed browser when the API is too dynamic to predict; local capture indexes route metadata.

The two-tool flow (resolve + execute) is the agent UX north star: never one call, never three. The shortlist is structured so the calling LLM picks; execute is paid from the agent's wallet (or sponsored credit) when the route is priced.

## Quickstart

For an MCP host (Claude Desktop, Cursor, Claude Code, Codex):

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

Then once:

```bash
npx unbrowse setup
```

For a shell:

```bash
unbrowse resolve --intent "search hacker news for openai" --url https://news.ycombinator.com
unbrowse execute --skill-id <id-from-resolve> --endpoint-id <id-from-shortlist>
```

For a Node program:

```bash
npm i @unbrowse/sdk
```

```typescript
import { spawn } from '@unbrowse/sdk';
const client = await spawn();
const resolved = await client.resolve({ intent: 'search hn for openai', url: 'https://news.ycombinator.com' });
const result = await client.execute({ skillId: resolved.skill.id, endpointId: resolved.endpoints[0].id });
```

## /contract-shape (why three surfaces stay coherent)

Every tool call on every surface follows the same shape:

1. **Declare** — the call carries an intent + URL.
2. **Iterate** — the runtime tries cached → marketplace → first-pass browser → live capture, in that order. Each step appends one trace row.
3. **Mark with proof** — the response carries a trace with `success`, `skill_id`, `endpoint_id`. The proof is the trace row.

Honest residue surfaces as a `next_step` field (`open_browse_session`, `abandon_or_authenticate`) instead of a one-word error.

## What lives in the public docs

Every primitive Unbrowse depends on (pointer-not-payload, residential proxy fallback, interstitial shortcut, x402+Faremeter, never-leaked-fields list, domain opt-out, fair split + claim, deploy gate, dimensional bench, kuri first-principles roadmap) is documented at [`docs/public/primitives/`](../../docs/public/primitives/) in the public repo. The README index there is enforced by `scripts/check-primitives-doc-public.sh` so the folder cannot drift from the codebase.

## Skill / MCP / SDK / CLI sync (the precommit gate)

When a shipping-surface signal changes (new top-level dir, new workspace member, new binary, new wrangler.toml target, new deploy workflow), the same commit must update a canonical doc. The gate at `scripts/precommit-doc-delta.sh` surfaces the delta as evidence on every iterate; full canonical wiring at `~/.claude/skills/meta-harness/scripts/gates/doc-delta.sh`.

The skill surface (this file) updates whenever the MCP tool catalog or the SDK API changes. The precommit gate flags it; the agent ships the update in the same commit.

## Provenance

Source code: <https://github.com/unbrowse-ai/unbrowse-dev>  
Public mirror: <https://github.com/unbrowse-ai/unbrowse>  
MCP server, CLI, SDK published from this monorepo. Backend (`backend/`) is the Cloudflare Worker that handles marketplace + sponsor tier; frontend (`frontend/`) is the landing page; `packages/skill/` is this package (the npm-published CLI binary + the skill manifest you're reading).
