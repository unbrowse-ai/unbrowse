# Adoption-Sandbox Wave 1 Findings

**Wave:** `artifacts/wave-20260521T003659Z`
**Date:** 2026-05-21
**Sandbox:** podman, fresh Ubuntu 24.04 arm64, Node 22.x, no prior unbrowse state
**Package tested:** `unbrowse@6.15.0` from npm
**Method:** harness collects raw artifacts per step; agent judges in-thread (substrate-faithful)

## What's working well

| Step | Result | Notes |
|---|---|---|
| `npm install -g unbrowse@latest` | 57s, 338 packages, exit 0 | Two harmless `npm warn deprecated`. Kuri auto-extracts to `~/.unbrowse/bin/kuri` on first command. |
| `unbrowse --version` | `6.15.0` in 0.2s | |
| `unbrowse --help` | 13.5KB, < 0.4s | "Quick paths" section is a real adoption win; intent-shaped questions map to commands. |
| `unbrowse setup --no-claude-register --skip-browser --opencode off` | 42s, exit 0 | Full pipeline: lobster-cli sub-install, sponsor-pool fallback, first-resolve nudge against jsonplaceholder, suggested next steps. Substantive output. |
| `unbrowse health` | `{"status":"ok",...}` | Returns version + git_sha + pid. Clean. |
| `unbrowse resolve --intent "..." --url https://news.ycombinator.com --no-execute` | 4.7s, exit 0 | `no_match` with concrete `next_step.command` — the agent-friendly behavior the contract requires. |
| `unbrowse mcp --help` | 5KB | Substantial help text. |

## Blockers + friction

### B1: `unbrowse skills` returns auth error to a sponsor-pool user

**Observed (step 08):**
```json
{"error":"Missing or invalid Authorization header","message":"Sign up at unbrowse.ai to get an API key."}
```

**Why this is bad:** Setup succeeded, resolve worked (via sponsor pool, no wallet, no key), but `unbrowse skills` (advertised in `--help` as "List all locally-cached skills") fails on auth. The inconsistency breaks the mental model an agent has just built. A new agent that ran `unbrowse resolve` and got data has no signal that `unbrowse skills` needs a different credential.

**Root cause:** There is no `GET /v1/skills` route in the local Fastify app (`src/api/routes.ts` only declares `/v1/skills/:skill_id` singular, plus per-skill subroutes). The plural list falls through to the backend Worker's auth middleware (`backend/src/middleware/auth.ts`), which rejects the unauthenticated request.

**Fix shape (separate PR):** Add a local `GET /v1/skills` route that enumerates the on-disk skill cache (the same cache `/v1/skills/:skill_id` already reads via `getRecentLocalSkill` and `domainSkillCache`). Local-first; falls back to backend only if the user has an API key configured.

### B2: Lobster-cli stderr leaks into setup output

**Observed (step 05, mid-output):**
```
Error: No active agent. Register one first:

  lobstercash agents register --name "<your agent name>"

Then retry your command.
(node:349) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.
```

**Why this is bad:** Looks like a fatal error to a first-time user. Setup actually catches it and falls through to the sponsor pool, but the raw error block plus a Node deprecation warning create alarm. The followup `[unbrowse] Continuing with the platform sponsor pool...` mitigates but doesn't suppress the noise.

**Fix shape (separate PR):** In `src/runtime/setup.ts`, when invoking `@crossmint/lobster-cli`, capture stderr separately and surface only on debug. Replace with a one-line non-alarming summary: `[unbrowse] No wallet yet — using sponsor pool ($1/day per agent).`

### B3 (already addressed in PR #601, merged): Bare error messages

**Observed (steps 10, 11, 12):**
- `unbrowse resolve` (no args) → `{"error":"--intent is required"}`
- `unbrowse execute` (no args) → `{"error":"--skill is required"}`
- `unbrowse go` (no args) → `{"error":"Usage: unbrowse go <url>"}`

This is the v6.15.0 baseline. PR #601 (merged 2026-05-21) upgrades all of these to include actionable examples and prerequisite-step pointers. The next published version (6.16.x or later) will pick these up; re-run this harness after release to confirm regression-free.

## Minor

- `setup`'s first-resolve demo uses `https://jsonplaceholder.typicode.com` — a fake-data API. Fine for the demo, but a more "real-world" example (GitHub, HackerNews) would carry more agent-UX signal.
- The "agent-native browser CLI" tagline + → arrows in `--help` Quick paths are well-designed visual cues. Keep.

## What the harness deliberately does NOT test (yet)

- **MCP wiring against a real Claude Desktop / Cursor config** — the sandbox writes `~/.codex/` and `~/.claude/` paths during setup but no real MCP client consumes them. Wave 2 should drop the generated `mcp.json` into a stubbed client and run a real `tools/list` over stdio.
- **Browse session (`go` → `snap` → `close`)** — Kuri's headless Chrome inside a podman container may need `--privileged` or a different image base (current Ubuntu image has no Chrome deps preinstalled). Deferred until B1+B2 are in.
- **Auth-walled site flow** — out of scope for an unauthenticated sandbox.

## Verdict for the agent

`unbrowse@6.15.0` is **adoptable from a clean Linux box in under 2 minutes** end-to-end through `resolve`. The first interactive command (`resolve`) returns an actionable `next_step` even on `no_match` — that is the agent-experience win. The two real frictions (B1 skills auth, B2 lobster noise) are scoped, fixable in single commits, and do not block the primary path.

## Re-running

```bash
bash .claude/test-unbrowse-npm-install-setup-mcp-wire-first-r/scripts/sandbox-adopt.sh
```

Each wave writes a fresh `artifacts/wave-<ts>/manifest.json` with per-step `out_excerpt` / `err_excerpt` (4KB tail each) so the next agent can read evidence inline without rerunning the container.
