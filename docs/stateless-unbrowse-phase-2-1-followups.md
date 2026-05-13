# Phase 2.1 Follow-ups — Deferred from Phase 2 (MCP Daemon Lifecycle)

**Source:** Jesus Loop Phase 2 NON-GOALS + OUT-OF-SCOPE in `.claude/jesus-loop.default.plan.md`.
**Status:** Phase 2 ships per-request spawn for MCP and removes the long-lived daemon assumption; the items below were explicitly scoped out and need to be revisited under their own triggers.

## Deferred — open follow-ups

### 1. CLAUDE.md "Always kill stale unbrowse server" note deletion

The note still applies for SIGKILL-during-in-flight-request edges and for users who explicitly run `unbrowse serve`. Phase 2 plan requires a two-week production observation window before pulling the note.

- **Trigger to revisit:** 14 days of production use with no observed stale-daemon incidents.
- **How to verify:** Sample `pkill -f 'unbrowse'` invocations from team Slack / issue tracker over the window. If count → 0, delete the note.

### 2. Warm-pool option (P2-1)

Phase 2's own risk register flagged "per-request process spawn adds significant latency" as high-likelihood. Day-5 cascade test came in at 17s end-to-end — workable, not great for hot paths.

- **Defer trigger:** Real-world `unbrowse <verb>` latency > 500ms at P95 in production logs.
- **Sketch:** `--pool N` flag keeps N worker processes warm; each request goes to a free worker, or queues if all busy. Lifetime-managed by the parent MCP process.

### 3. Option B — extract route handlers, eliminate HTTP listener (P2-2)

MCP currently proxies through `localhost:6969` into Fastify routes. The cleaner shape is route handlers as pure functions called in-process. **126KB of routes** in `src/api/routes.ts` is too large a blast radius for one loop.

- **Trigger:** If observability/scale forces it, or if item #2's warm-pool can't keep up with latency demands.
- **Sketch:** Lift each route handler into `src/api/handlers/*.ts` with a typed `(req) => res` signature; Fastify routes become thin adapters; MCP calls handlers directly.

### 4. MCP-spawned ephemeral port (P2-3)

`unbrowse serve` and MCP-auto-spawned daemons both contend on `:6969`. If a user runs `unbrowse serve` explicitly while MCP also auto-spawns, both hit the port and one fails.

- **Defer trigger:** When real users hit the conflict (issue tracker / Discord).
- **Sketch:** When `MCP_SERVER_MODE=1`, pick an ephemeral port and pass via `UNBROWSE_URL` to the spawned child. `unbrowse serve` stays on `:6969` by convention.

### 5. bench-local baseline durability

Phase 2 Day 6 (this loop) established the first `.bench-local/` baseline. Without weekly refreshes the baseline staleness eats its own value — future PRs can't compare against a moving target.

- **Trigger:** None — this is a maintenance commitment, not event-driven. Run at least weekly during Phase 2.1.
- **Sketch:** Add `scripts/bench-local-snapshot.sh` that timestamps `results.jsonl` → `.bench-local/snapshots/<date>.jsonl`. Wire into a weekly cron or release-prep checklist.

## Honesty pass — real vs speculative triggers

- **Real triggers** (a metric or event will fire them): #1 (observation window), #2 (P95 latency), #4 (user conflict report).
- **Maintenance commitments** (no trigger, just discipline): #5.
- **Speculative** (only revisit if forced by #2): #3 — large refactor, do not chase pre-emptively.
