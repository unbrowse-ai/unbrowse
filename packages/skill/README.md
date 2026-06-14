# Unbrowse

**Fill one internet hole; index the route when the runtime has to discover it.** The agent
supplies intent plus optional URL/params/approval. Unbrowse chooses the cheapest capable
layer — route graph, installed skill, adapter, local primitive, browser capture with local
cookies/HAR — and returns a contract-shaped result. If it had to discover a route, that
route can be indexed so every later agent gets the fast path.

One agent learns a site once. Every later agent gets the fast path.

> **Primary surface: the hole/contract.** `SKILL.md` (shipped in this package) teaches
> agents to fill one hole, not juggle a dozen route/debug verbs. The formal bridge is
> `unbrowse contract surface`; the CLI expression is `unbrowse fill "task" [--url <url>]`;
> the SDK expression is `createHole().fill(...)`. Old
> `resolve`/`execute`/`go`/`snap` CLI verbs remain as advanced compatibility and debugging
> surfaces. **MCP is legacy** — still supported, but no longer the recommended path.

```bash
npm install -g unbrowse
unbrowse setup        # one-time: registration, browser engine, local credentials
```

```bash
unbrowse contract surface   # inspect the current hole/contract bridge
unbrowse fill "top stories with points"
unbrowse fill "top stories with points" --url https://news.ycombinator.com
```

---

## What the client does

Unbrowse is a **local, stateless CLI**. Each invocation runs an in-process runtime — there is
**no background daemon and no port** to manage. A separate browser broker (Kuri) is spawned
only when a task actually needs a live browser. Credentials and sensitive inputs never leave
your machine; only sanitized route metadata is shared when you publish.

### The Agent Contract — One Hole, Cheapest-Capable Descent

The client exposes holes only:

- `intent` — the task the model wants filled.
- `wallet_proof` — the identity/authorization proof.
- `approval` — human approval for mutations or policy-sensitive actions.
- `local_capability_result` — what the local dispatcher returned after invoking a local tool.
- `typed_pointer` — server-owned pointer to a result/contract, not a secret payload.

The runtime walks the graph cheapest-capable-first and stops at the first settled witness.
The browser is not the agent-facing contract; it is the deepest fallback and the capture
oracle for missing routes.

### SDK: the one tool

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const result = await hole.fill({
  intent: "get the current npm express version and weekly downloads",
  url: "https://www.npmjs.com/package/express",
});
```

`fill` may reuse a route, call a standard adapter, open a browser, use local cookies/HAR,
capture, and index. The agent does not choose those internal verbs.

### Legacy CLI: route inspection and debugging

Use this when you need to force or inspect a route:

```bash
unbrowse resolve --intent "top stories" --url "https://news.ycombinator.com" --pretty
unbrowse execute --skill <id> --endpoint <id> --pretty
```

Browser verbs are also legacy/debug escape hatches:

```bash
unbrowse go "https://site.com/booking"
unbrowse snap --filter interactive      # accessibility snapshot with @eN refs
unbrowse click e5
unbrowse fill e8 "2 adults"
unbrowse submit --wait-for "/time-selection"
unbrowse close                          # checkpoints + indexes the learned route
```

Treat each successful `submit` as a dependency boundary. `close` records which request chain
unlocked the next page so future fills can replay the real flow.

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

**Current path:** `fill` · `contract surface` · SDK `createHole().fill(...)`
**Advanced compatibility:** `resolve` · `execute` · `run` · `fetch` · `search` · `explain`
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

Then `npx unbrowse setup --mcp` once. Tools mirror the compatibility CLI: `unbrowse_resolve`, `unbrowse_execute`,
`unbrowse_search`, the browse chain (`unbrowse_go`, `unbrowse_snap`, `unbrowse_click`,
`unbrowse_fill`, `unbrowse_submit`, `unbrowse_sync`, `unbrowse_close`, …), and
`unbrowse_skills` / `unbrowse_sessions`. A generic template is published at
[`/mcp.json`](https://www.unbrowse.ai/mcp.json). MCP is the old route-inspection
view under the one-hole contract: `unbrowse_resolve` first, then
`unbrowse_execute`; escalate to the browse chain only when debugging a miss.

---

## License

AGPL-3.0 — see [LICENSE](LICENSE).
