# Unbrowse

**Turn any website into reusable, indexed API routes for agents.** Teach a route once by
browsing; replay it on every later call — a replay is ~30× faster and ~90× cheaper than a
fresh browser session ([peer-reviewed: 3.6× mean / 5.4× median speedup over Playwright
across 94 live domains](https://unbrowse.ai/whitepaper)).

One agent learns a site once. Every later agent gets the fast path.

> **Two primary surfaces: the Skill and the CLI.** `SKILL.md` (shipped in this package) gives
> any skill-aware agent the full map — load it and the agent drives the CLI directly. The CLI
> is the runtime everything else calls. **MCP is legacy** — still supported (see the bottom of
> this file), but no longer the recommended path.

```bash
npm install -g unbrowse
unbrowse setup        # one-time: registration, browser engine, local credentials
```

```bash
# the load-bearing two-call path: is there a known route? then run it.
unbrowse resolve --intent "top stories" --url "https://news.ycombinator.com"
unbrowse execute --skill <id> --endpoint <id>
```

---

## What the client does

Unbrowse is a **local, stateless CLI**. Each invocation runs an in-process runtime — there is
**no background daemon and no port** to manage. A separate browser broker (Kuri) is spawned
only when a task actually needs a live browser. Credentials and sensitive inputs never leave
your machine; only sanitized route metadata is shared when you publish.

### The agent contract — two calls, then browse only on a miss

1. **`resolve`** — "is there an indexed route for this intent + URL?" Returns a ranked
   shortlist of endpoints (you pick one) or an honest cache miss.
2. **`execute`** — runs the one endpoint you picked and returns the real data.
3. **browse** (`go → snap → act → sync/close`) — the escalation. When `resolve` misses, drive
   a real browser; passive capture indexes the route so the next caller skips to resolve +
   execute.

Two calls for a known route — never one, never three. When a call can't complete, the response
carries an honest `next_step` (e.g. `open_browse_session`, `auth_required`) instead of a bare
error. Three execution paths, fastest first:

1. **Skill cache** — instant (<200 ms): a route already learned locally.
2. **Shared route graph** — sub-second: a route another agent already mined.
3. **Browser session** — full traversal: the source of truth for a new site.

### Reads

```bash
unbrowse resolve --intent "get stock price" --url "https://finance.example.com"
unbrowse execute --skill <id> --endpoint <id> --pretty
unbrowse fetch https://api.github.com/repos/oven-sh/bun     # one-shot URL → content
unbrowse run "https://site.com" "list the items"            # resolve → execute → capture-on-miss
```

### Writes — agent-native, intent-first

You express **intent**, not an HTTP verb. The method is inferred from the intent and whether a
body is present; an explicit `--method` always overrides.

```bash
# verb inferred from intent ("create" → POST, "update" → PATCH, "delete" → DELETE):
unbrowse execute --url "https://api.example.com/posts" \
  --intent "create a post" --body '{"title":"hello","userId":1}'

# or explicit:
unbrowse execute --url "https://api.example.com/posts/1" --method PUT --body '{...}'
```

- **Mutation safety.** A write is a deliberate action: POST/PUT/PATCH/DELETE only fire when you
  ask for them; `--dry-run` previews without side effects; policy-sensitive domains require an
  extra confirmation. Reads (GET) auto-execute.
- **Sensitive inputs stay local.** A field that looks like a secret (password, token, api_key…)
  reaches the *target* in clear but is never written to disk or shared in clear — a redacted
  placeholder is stored in its place, so a saved or published route keeps its shape without ever
  leaking the value.
- **Created-resource chaining (`--session`).** Pass `--session <id>` and a write's created id is
  remembered, then auto-fills a matching field on a later call in the same session. State
  persists to disk, so a *separate* CLI invocation with the same `--session` inherits it (the
  stateless binary gets state the way it gets cookies).
- **Cross-route suggestions.** If a call needs a value no local route can supply, the response
  names which *other* indexed route produces it — so an agent can chain across sites.

### Browse (escalation for JS-heavy / first-time sites)

```bash
unbrowse go "https://site.com/booking"
unbrowse snap --filter interactive      # accessibility snapshot with @eN refs
unbrowse click e5
unbrowse fill e8 "2 adults"
unbrowse submit --wait-for "/time-selection"
unbrowse close                          # checkpoints + indexes the learned route
```

Treat each successful `submit` as a dependency boundary — trust the returned `url` /
`session_id` / next-step hints over guessed downstream URLs. `sync` records which request chain
unlocked the next page, so future agents replay the real flow.

### Auth for gated sites

```bash
unbrowse auth-capture --url "https://x.com/login"   # sign in once; the session stays local
```

Sign-in works from your existing browser session or an interactive login window. Auth material
is stored encrypted locally, reused only by your local runtime, and discarded when a site
rejects it. The marketplace receives route metadata, never your session.

### Keeping current

The client **auto-updates in the background** for global npm installs (a detached
`npm i -g unbrowse@latest`, throttled, effective next run — it never blocks the command you
ran). Opt out with `UNBROWSE_NO_AUTO_UPDATE=1`. Check/upgrade manually any time:

```bash
unbrowse upgrade
```

---

## Command reference

**Agent path:** `resolve` · `execute` · `run` · `fetch` · `search` · `explain`
**Browse session:** `go` · `snap` · `click` · `fill` · `type` · `press` · `select` · `scroll` ·
`submit` · `screenshot` · `text` · `markdown` · `eval` · `back` · `forward` · `sync` · `close` ·
`inspect` · `capture`
**Auth & sessions:** `auth-capture` / `login` · `auth-inventory` · `sessions` · `cookies`
**Routes & marketplace:** `skills` · `skill` · `spec` · `feedback` · `annotate` · `review` ·
`index` · `publish` · `cleanup-stale`
**Account & ops:** `setup` · `upgrade` · `health` · `account` · `settings` · `config` · `stats` ·
`billing` · `dashboard` · `wallet`

Run `unbrowse <command> --help` for flags. `unbrowse health` is a quick local check.

---

## Quick start (alternatives)

```bash
# one-line install from the latest GitHub release (binary-first):
curl -fsSL https://unbrowse.ai/install.sh | sh
```

`unbrowse setup` runs the first-time bootstrap: ToS acceptance, agent registration + API-key
caching (in `~/.unbrowse/config.json`), browser-engine verification, and wallet detection. If a
wallet is configured it becomes the contributor/payout and paid-route spending wallet —
Crossmint `lobster.cash` is encouraged during setup (`LOBSTER_WALLET_ADDRESS`); other providers
use `AGENT_WALLET_ADDRESS` / `AGENT_WALLET_PROVIDER`.

The npm package is binary-first: install downloads the prebuilt Bun-compiled CLI for your
platform (no TypeScript runtime shipped). Works with Claude Code, Open Code, Cursor, Codex,
Windsurf, and any host that can call a local CLI or load a skill.

Public docs: [docs.unbrowse.ai](https://docs.unbrowse.ai) · Discord:
[discord.gg/VWugEeFNsG](https://discord.gg/VWugEeFNsG)

---

## How it works

When an agent asks for something, Unbrowse searches the shared marketplace for an existing
route. If one exists with enough confidence, it executes immediately. If not, it opens a local
browser session, learns reusable route metadata, and publishes it only after the configured
checkpoint. Every learned route becomes discoverable by every future agent; reliability
scoring, feedback, schema-drift detection, and verification keep good paths hot and broken ones
out of the way.

**Resolution priority:** route cache (5-min TTL) → marketplace semantic search (composite of
embedding similarity, reliability, freshness, verification) → local browser capture → DOM
extraction for static/SSR sites.

### The marketplace flywheel

Every new user makes the platform more valuable for the next — like Waze, but for the web's
APIs. Routes live in a shared marketplace at `beta-api.unbrowse.ai`; routes published by any
agent are discoverable by all. A verification loop runs safe (GET) endpoints periodically;
routes with repeated failures auto-deprecate.

---

## Configuration

```
~/.unbrowse/config.json          # API key, agent id, registration
~/.unbrowse/vault/               # encrypted local credential store
~/.unbrowse/skill-cache/         # local route (skill) manifest cache
~/.unbrowse/yield-sessions/      # per-session created-resource state (--session)
~/.unbrowse/profiles/<domain>/   # per-domain browser profiles
~/.unbrowse/logs/                # daily logs
```

| Variable | Default | Description |
| --- | --- | --- |
| `UNBROWSE_API_URL` | `https://beta-api.unbrowse.ai` | Marketplace / backend URL |
| `UNBROWSE_CONFIG_DIR` | `~/.unbrowse` | Local config + cache directory |
| `UNBROWSE_NO_AUTO_UPDATE` | — | Set to `1` to disable background auto-update |
| `UNBROWSE_AGENT_EMAIL` | — | Email-style agent name for headless registration |
| `UNBROWSE_TOS_ACCEPTED` | — | Accept ToS non-interactively |
| `UNBROWSE_URL` | — | Point the CLI at an external compatibility server (unset = in-process) |
| `HEADLESS` | `true` | Set `false` to show the browser window (dev/auth flows) |

(`unbrowse setup` registers with the marketplace and caches credentials on first run; headless
setups can pass `UNBROWSE_AGENT_EMAIL` + `UNBROWSE_TOS_ACCEPTED`.)

---

## Legacy: MCP server

Unbrowse still implements the Model Context Protocol over stdio for hosts that prefer it, but
**the Skill + CLI are the primary path now.** `unbrowse mcp` is the stdio entrypoint; it drives
the same in-process runtime (no daemon, no port).

```json
{
  "mcpServers": {
    "unbrowse": { "command": "npx", "args": ["-y", "unbrowse", "mcp"] }
  }
}
```

Then `npx unbrowse setup` once. Tools mirror the CLI: `unbrowse_resolve`, `unbrowse_execute`,
`unbrowse_search`, the browse chain (`unbrowse_go`, `unbrowse_snap`, `unbrowse_click`,
`unbrowse_fill`, `unbrowse_submit`, `unbrowse_sync`, `unbrowse_close`, …), and
`unbrowse_skills` / `unbrowse_sessions`. A generic template is published at
[`/mcp.json`](https://www.unbrowse.ai/mcp.json). The same two-call contract applies:
`unbrowse_resolve` first, then `unbrowse_execute`; escalate to the browse chain on a miss.

---

## License

AGPL-3.0 — see [LICENSE](LICENSE).
