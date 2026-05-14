# MCP Telemetry — Session Trace, Reflection, and Upstream Triage

**Status:** Planned, not yet built
**Date:** 2026-05-14
**Driver:** Capture real agent UX evidence so we fix the right things. Today we ship features blind to "did the calling agent actually achieve what it set out to do, and how slowly". This doc defines the three-phase build that closes that gap without violating the substrate-enables-never-prescribes principle.

## North-star outcome

Every Unbrowse MCP session produces an anonymised, structured trace of *what the agent tried, how long each step took, whether the agent declared the intent achieved, and what the substrate observed along the way*. Bad/slow experiences cluster into Linear issues for human triage; signal-rich ones become `unbrowse-dev` GitHub issues. The agent layer ships **raw evidence only**; classification of "bad" lives in a worker-side LLM judge, never in client-side `BAD_PATTERN` constants.

## Hardcoding guards (read before editing this plan)

These are non-negotiable per `CLAUDE.md > The substrate enables; it does not prescribe`:

- **No `SLOW_THRESHOLD_MS = 5000`, `BAD_TOOL_SEQUENCES`, `BUG_KEYWORDS`** anywhere in `src/telemetry/*` or `backend/src/routes/telemetry.ts`. The client emits durations + sequences; the worker judges via LLM over clustered evidence.
- **No format templates putting words in the agent's mouth.** `unbrowse_reflect` accepts `{intent_status}` from the agent — the substrate does not generate "you previously failed to..." prose into the agent's context.
- **No persona rules keyed on transcript text.** Reflection nudges live in tool response payloads (`_workflow_hints`) and the MCP `instructions` field — they describe affordances, not "if user says X, do Y".
- **No invented contracts.** Reflection schema is `{intent_status: "achieved"|"failed"|"partial", notes_hash?: string}` — that's it. No `IntentSummary` / `BugReport` typed structs the agent must populate.
- **No tests asserting strings I authored on both sides.** Trace assertions must read real session output and check shape (presence of `tool_end` with `duration_ms`), not literal phrases.

If a future commit to this surface looks like prescription, revert it and find the gap one layer deeper.

## Architecture (three phases)

### Phase 1 — Local trace + opt-in plumbing (client-only, no network)

**Goal:** Every MCP-served tool call appends a structured event to a local JSONL session log. Disabled-by-config is a no-op. No upload yet.

**Files:**

```
src/telemetry/
  session-log.ts        # SessionLogger class — open file, append events
  sanitize.ts           # hash entity values, strip PII patterns, redact args
  config.ts             # read/write ~/.unbrowse/config.json telemetry block
  index.ts              # re-exports
```

**Behavior:**

- On MCP server boot (`src/mcp.ts` startup hook), read `~/.unbrowse/config.json` → `telemetry.enabled`. Also honor `UNBROWSE_TELEMETRY=0` env override (env takes precedence). If disabled, install a no-op logger interface — zero overhead on the hot path.
- If enabled, generate a session UUID (`crypto.randomUUID()`), open `~/.unbrowse/sessions/<uuid>.jsonl` for append, write a `session_start` event with: `{ts, session_id, mcp_version, node_version, platform, agent_kind: "mcp"}`. No user identifier, no hostname.
- Wrap the MCP tool dispatch (the `CallToolRequestSchema` handler in `src/mcp.ts`). For each call:
  - Before: append `{ts, session_id, event: "tool_start", call_id, tool, args_fingerprint}` where `args_fingerprint` is the sanitized form (see `sanitize.ts` below).
  - After: append `{ts, session_id, event: "tool_end", call_id, tool, duration_ms, success: bool, error_code?: string, decision_trace?: <pass-through>, response_summary: <sanitized shape>}`.
- On process exit (SIGTERM/SIGINT + Node `beforeExit`): write `session_end` event with `{ts, session_id, duration_ms_total, tool_calls_total, errors_total}`. Flush. (No upload in Phase 1 — file just sits there.)

**Sanitization rules (`sanitize.ts`):**

Per the agreed answer: strip everything PII-shaped including intent text. Concrete rules:

- **URLs**: parse, keep `scheme + host + path-template`. Replace each path segment that looks like an entity (numeric ID, UUID, hex >= 8 chars, email, slug with `@`, anything containing `.com`) with `{id}` / `{uuid}` / `{email}` / `{slug}`. Replace all query values with `<hash:8>` (sha256 first 8 chars), keep query keys.
- **Intent strings** (anywhere they appear in args — `unbrowse_resolve { intent }`, `unbrowse_execute { intent }`, etc.): replace with `{intent_hash: <sha256:16>, length: N, word_count: M}`. Hash is deterministic so identical intents cluster, but text is irrecoverable.
- **Free-text fields** (notes, descriptions, error messages from upstream): scan for email / phone / IPv4 / IPv6 / UUID / credit-card-shape patterns; replace each match with `<email>` / `<phone>` / `<ip>` / `<uuid>` / `<card>`. Pass the residual prose through (so error messages like "rate limited" survive but `lewis@foundry.com` doesn't).
- **Headers**: never include in the trace at all. Already stripped at capture; double-check at trace boundary.
- **Response bodies**: never include verbatim. Emit `response_summary: {shape: "array"|"object"|"string", item_count?: N, bytes: B, top_keys?: [k1,k2,k3]}` — schema-level only.
- **Decision trace pass-through**: `decision_trace` arrays from `executeEndpoint` are already structural (step names per the convention). Pass through unmodified — they contain no PII.

**Config (`~/.unbrowse/config.json`):**

```json
{
  "telemetry": {
    "enabled": true,
    "session_id_seed": "<random uuid generated at setup>",
    "upload_endpoint": "https://beta-api.unbrowse.ai/v1/telemetry/session"
  }
}
```

`session_id_seed` is *not* sent in events — it's local-only, used in Phase 3 for opt-out revocation (the seed becomes a delete-key the user can send to wipe their historical clusters server-side).

**Setup flow (`packages/skill/scripts/setup.*` or wherever `unbrowse setup` lives — Phase 1 follow-up):**

`unbrowse setup` adds one prompt:

```
Help improve Unbrowse?
We can send anonymous bug reports (tool sequences + timings + error codes,
no URLs, no intent text, no identifiers) so we can fix slow paths.
You can disable this any time with `unbrowse telemetry off` or
UNBROWSE_TELEMETRY=0. [Y/n]
```

Default Y. Writes `telemetry.enabled` accordingly. New CLI subcommand: `unbrowse telemetry [on|off|status]`.

**Tests (no mocks per `CLAUDE.md`):**

- `tests/telemetry-session-log.test.ts` — spawn real MCP server with `UNBROWSE_TELEMETRY=1` and `HOME=$(mktemp -d)`. Issue real tool calls (`unbrowse_health` for stateless). Read the produced `.jsonl`. Assert: `session_start` exists, every `tool_start` has matching `tool_end` by `call_id`, `duration_ms` is a number, no raw URL appears in any line, intent fingerprint is `{intent_hash:..., length:..., word_count:...}` shape.
- `tests/telemetry-sanitize.test.ts` — feed `sanitize.ts` real-shape inputs (URLs with reddit post IDs, emails in error messages, jwt-looking auth headers). Assert the output contains only the redacted forms. Falsifier: mutation-test by removing the sanitizer call entirely and confirm the test fails.
- `tests/telemetry-disabled-noop.test.ts` — set `UNBROWSE_TELEMETRY=0`, spawn MCP, run tool, assert no file appears in `~/.unbrowse/sessions/`.

**Done when:**

- `bun test tests/telemetry-*.test.ts` green.
- Manual: run a real MCP session, inspect `~/.unbrowse/sessions/<uuid>.jsonl`, confirm intent text is unreadable, URL templates are usable for clustering.
- `unbrowse telemetry status` reports current setting; `unbrowse telemetry off` flips and is honored on next session.

---

### Phase 2 — Agent reflection nudge

**Goal:** Add the `unbrowse_reflect` tool and the workflow-hint scaffolding that *encourages* (never forces) the agent to declare intent outcome. Agent-declared outcome is the only honest signal for "achieved what the user wanted" — the substrate cannot infer it from tool sequences alone.

**Files:**

```
src/mcp.ts                          # register unbrowse_reflect, add _workflow_hints.reflect_when_done to resolve/execute responses, add MANDATORY reflection note to server instructions
src/telemetry/reflect.ts            # handler — write reflection event to current session log
```

**Tool schema (added to `src/mcp.ts`):**

```ts
{
  name: "unbrowse_reflect",
  description: "Declare the outcome of the intent you just pursued. Call this once per user-facing goal, after the agent believes the goal is achieved, failed, or partially complete. The substrate uses this to surface bad paths to maintainers — it does not change your runtime behavior. Anonymous: only intent_status (and optional hashed notes) are recorded; no transcript text.",
  inputSchema: {
    type: "object",
    properties: {
      intent_status: { type: "string", enum: ["achieved", "failed", "partial"] },
      notes_hash: { type: "string", description: "Optional sha256:16 fingerprint of free-text notes about what went wrong. Hash locally before sending if you must include it — never raw text." }
    },
    required: ["intent_status"]
  }
}
```

Handler appends `{ts, session_id, event: "reflection", intent_status, notes_hash}` to the session log. Returns `{ok: true, recorded: true}`. No side effects beyond the log line.

**Nudge surfaces (3 of them, declarative not prescriptive):**

1. **MCP `instructions` field** (the server-level capability description sent to clients):

   Append one paragraph to the existing instructions:

   > "When the user-facing goal you were pursuing is complete (achieved, failed, or partial), call `unbrowse_reflect` once with the outcome. This helps surface slow or broken paths to maintainers. The signal is anonymous — only the outcome value is recorded. Skip the call if you are running diagnostics rather than pursuing a user intent."

   This describes the affordance. It does not enumerate "if X then Y" rules.

2. **`_workflow_hints.reflect_when_done` on resolve/execute responses:**

   The existing `_workflow_hints` prose-only field (see `docs/mcp-vs-cli-ux-audit.md`) gains one structured key:

   ```json
   "_workflow_hints": {
     "reflect_when_done": "Call unbrowse_reflect with intent_status when the user's goal is complete."
   }
   ```

   Single static string. No templating. No conditional "if you got 0 results say X". The agent reads it once and remembers — we don't need to nag every response.

3. **Auto-reflection fallback** (substrate side, structural):

   On `session_end`, if no `reflection` event was logged during the session, emit `{event: "reflection_missing", auto: true, ts: <now>}`. This is *evidence*, not a verdict. The triage worker can decide whether missing reflection correlates with bad UX. We do not infer `intent_status: failed` from absence — that would be the substrate guessing at the agent's intent.

**What this phase deliberately does NOT do:**

- No "block next tool call until reflect is called" — that fights the substrate principle, blocks legitimate diagnostic sessions, and breaks composition with other MCP servers.
- No "if the trace contains 3+ errors, auto-emit intent_status: failed" — the agent might have been intentionally probing error paths.
- No format templates writing prose into the agent's context after a non-reflection ("you forgot to reflect last time...") — that's putting words in the agent's mouth.

**Tests:**

- `tests/telemetry-reflect.test.ts` — spawn MCP, call `unbrowse_resolve`, then `unbrowse_reflect {intent_status: "achieved"}`. Assert the session log contains a `reflection` event with the right status.
- `tests/telemetry-reflect-missing.test.ts` — spawn MCP, call one tool, close without reflecting. Assert `session_end` is followed by (or includes) a `reflection_missing: auto` marker.
- `tests/telemetry-workflow-hint.test.ts` — call `unbrowse_resolve` for any intent, assert response carries `_workflow_hints.reflect_when_done` as a string.

**Done when:**

- `unbrowse_reflect` tool appears in `tools/list` MCP response.
- A real session log shows the reflection event when the agent calls the tool.
- A real session log shows `reflection_missing` when it doesn't.

---

### Phase 3 — Upload, worker triage, Linear staging

**Goal:** Session logs get POSTed to a Cloudflare worker route on session close. A scheduled triage worker clusters sessions and stages issues into a Linear inbox project for human review. Promotion to `unbrowse-dev` GitHub issues is manual until the cluster signal is tuned.

**Client side (`src/telemetry/upload.ts`):**

- On `session_end`, if telemetry enabled and online: read the full session JSONL, POST to `${config.upload_endpoint}` with body `{session_id, events: [...]}`. Single shot, no retry queue in Phase 3 (we lose offline sessions — acceptable; users can re-enable upload later for queued).
- Timeout 5s. If fail, log to stderr only (never to the session file itself — recursion). Keep the local JSONL regardless.
- Send a hashed `agent_kind_fingerprint` header derived from `mcp_version + node_version + platform` — so we can rate-limit per (likely-)agent without identifying them.

**Backend route (`backend/src/routes/telemetry.ts`):**

```
POST /v1/telemetry/session
  body: { session_id: string, events: Array<EventLine> }
  rate-limit: 60/min per agent_kind_fingerprint
  storage: D1 table `telemetry_sessions`
```

D1 schema (initial — extend with migration as needed):

```sql
CREATE TABLE telemetry_sessions (
  session_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  duration_ms_total INTEGER,
  tool_calls_total INTEGER,
  errors_total INTEGER,
  reflection_status TEXT,  -- 'achieved'|'failed'|'partial'|'missing'
  events_json TEXT NOT NULL,  -- the full sanitized event stream
  agent_kind_fingerprint TEXT,
  mcp_version TEXT,
  platform TEXT
);
CREATE INDEX idx_telemetry_received ON telemetry_sessions(received_at);
CREATE INDEX idx_telemetry_reflection ON telemetry_sessions(reflection_status);
```

Worker validates: every event has `ts` and `event`, no field over 1KB (sanity ceiling), `events_json` total size under 256KB. Reject otherwise — 413 with reason.

**Triage worker (`backend/src/jobs/triage-telemetry.ts`, Cloudflare cron `0 * * * *`):**

- Pull last hour of sessions from D1.
- Cluster by `(host_template, tool_sequence_prefix[:4], terminal_error_code, reflection_status)`. Use Workers AI or call an LLM (Claude Haiku via `ANTHROPIC_API_KEY`) on each cluster's representative sample to produce a one-paragraph "what's the agent struggling with here" description.
- For clusters with `count >= 5` AND `reflection_status in ('failed','partial','missing')` AND no existing Linear issue matching the cluster key:
  - Open a Linear issue in a `Telemetry Triage` project (new — needs creation), title `[telemetry] <host_template> <terminal_error_code> ×<count>`, body containing the LLM description + representative session_ids + cluster key. Label `triage-needed`.
- Cluster keys are stored in `telemetry_clusters` D1 table to dedupe across runs.

**Promotion to `unbrowse-dev`** is manual until the cluster signal is tuned (Lewis or a maintainer reviews the Linear inbox weekly, promotes high-signal ones to GitHub issues via Linear → GitHub integration or by hand). After ~2 weeks of inbox curation we revisit whether auto-promotion is safe.

**Privacy / opt-out endpoint:**

```
DELETE /v1/telemetry/sessions?seed=<session_id_seed>
```

The local `session_id_seed` (from `~/.unbrowse/config.json`) hashes deterministically into every session this client emits (we add `client_seed_fp: sha256(seed):16` to each `session_start`). A user who runs `unbrowse telemetry purge` POSTs their seed, the worker hashes it, deletes every matching row. No identity, but a deterministic delete-key.

**Tests:**

- `backend/tests/telemetry-route.test.ts` — real POST to the worker (against a wrangler dev or staging URL via env-gated test), assert 200 + D1 row exists.
- `backend/tests/telemetry-rate-limit.test.ts` — burst 100 requests in 10s with same fingerprint, assert later ones 429.
- `backend/tests/telemetry-triage-cluster.test.ts` — seed D1 with 10 sessions matching one cluster key, run triage worker, assert one Linear issue is created (mock Linear API only at the network boundary — actual cluster logic runs for real).
- `backend/tests/telemetry-purge.test.ts` — POST session with seed, DELETE with same seed, assert row gone.

**Done when:**

- An MCP session in production results in a D1 row within seconds of `session_end`.
- A synthetic cluster of 5+ failing sessions on the same host produces a Linear issue.
- `unbrowse telemetry purge` clears server-side state for that install.

---

## Cross-phase guards

- **CHANGELOG entry per phase** — Phase 1 / Phase 2 / Phase 3 each get a `feat(telemetry):` line.
- **`bench-local` corpus addition** — at least one corpus case exercises the full trace path so the harness catches future regressions to event shape.
- **`tests/extraction-filter-bypass.test.ts` parallel for sanitizer**: any new redaction pattern gets a matching test so a future "let me just allow this through" can't silently regress.
- **No new MCP tool descriptions hardcoded into prose decision trees.** `unbrowse_reflect`'s description states the affordance — it does not enumerate `"if you searched and got 0 results, call this with failed"`.
- **Audit grep before every release touching telemetry:**

  ```bash
  grep -rEn 'SLOW_THRESHOLD|BAD_PATTERN|BUG_KEYWORD|reflect.*MUST|reflect.*FORCED' src/telemetry backend/src/routes/telemetry.ts backend/src/jobs/triage-telemetry.ts
  ```

  Expected zero hits. Anything matching is prescription debt — revert.

## Open questions to revisit after Phase 1 ships

1. Should `unbrowse_reflect` accept richer outcome fields (`steps_wasted`, `time_to_first_useful_result`)? Phase 1 evidence will tell us if `intent_status` alone clusters well.
2. Should the triage worker LLM judge run per-cluster or per-session-then-aggregate? Per-cluster is cheaper; per-session catches edge cases the cluster lumps together.
3. At what cluster-count threshold should auto-promotion to GitHub kick in? Defer until Linear inbox has 50+ clusters of real data.
4. Do we want a `unbrowse_reflect_skip` reason field (`"diagnostic_run"`, `"capture_only"`) so the triage worker can ignore intentional non-pursuit sessions? Probably yes, but add when we see noise from auto-reflection-missing markers.

## Non-goals (for clarity)

- Not a billing / metering system — that's `backend/src/middleware/sponsor.ts`.
- Not a debugger UI — raw JSONL is the inspection surface; building a viewer is out of scope here.
- Not realtime — sessions upload on close, triage runs hourly. Sub-minute latency is not a goal.
- Not Sentry / Datadog — we are not adopting third-party APM. The telemetry channel is Unbrowse-specific because the signal we care about (agent UX, intent outcome) doesn't exist in generic APM.

---

## Future requirement (Phase 4, separate work) — API-key gate on indexing

**Decision date:** 2026-05-14
**Status:** Locked as direction, not scheduled. Telemetry phases 1–3 ship without this constraint; Phase 4 lands it once the auth surface is ready.

**What changes:** Future versions of Unbrowse will **not index, capture, publish, or contribute to the marketplace** without a valid Unbrowse account-bound API key. The local resolve/execute/fetch paths against already-cached skills may stay open (TBD), but anything that writes to the shared marketplace requires a real account behind it.

**Why:**

- Today the marketplace fills itself from anonymous traffic. That worked for bootstrap, but it makes telemetry signal hard to attribute and lets bad actors poison the index at zero cost.
- Tying every indexing event to an authenticated account gives us: per-account abuse signal, real earnings ledgers (x402 payouts need a wallet behind a real identity), and a way to deprecate stale endpoints by knowing who published them.
- It also closes the telemetry loop: a `client_seed_fp` becomes an `account_id_fp` (hashed), so triage clusters carry an attribution dimension we can use to reach out to real users when their flows break.

**What "valid" means:**

- API key resolves on the backend to a non-revoked account.
- Account has accepted the current ToS revision (so we can update terms without breaking existing installs silently).
- Account is not rate-limit-exhausted or banned.

**Surfaces this touches (do NOT change in Phases 1–3, list is for Phase 4 planning):**

- `unbrowse setup` — must collect or generate an API key via OAuth/magic-link, write to `~/.unbrowse/config.json` under `auth.api_key`.
- `unbrowse_index`, `unbrowse_publish`, `unbrowse_publish_suggestions`, `unbrowse_annotate` (MCP tools that write to marketplace) — wrap with `requireValidApiKey()` middleware; refuse with structured `next_step: "run_unbrowse_setup"` when missing/invalid.
- `executeBrowserCapture` + `mergeEndpoints` + `cachePublishedSkill` + `queueBackgroundIndex` — gate at the capture pipeline boundary so passive indexing doesn't sneak past the tool layer.
- Backend `POST /v1/marketplace/skills` and friends — already auth-gated for publish; verify all write routes share the gate. Read routes stay open (resolve must work for anonymous installs as a discovery surface).
- Telemetry session events — when API key is present, emit `account_id_fp: sha256(api_key):16` in `session_start`. Never the raw key. This is opt-in account-linked clustering.

**Hardcoding guards specific to this phase:**

- No allowlist of "trusted" accounts in client code. Validity is a backend question, asked at runtime.
- No "developer mode bypass" baked into the binary. If we need a dev escape hatch, it goes behind an env var that the backend explicitly knows about and grants (so revocation is server-side).
- No hardcoded grace period for expired keys. The backend returns `{valid: false, reason: "expired", suggested_action: "..."}` and the client surfaces that. Never client-side guesses.

**Migration path (when Phase 4 ships):**

1. Two-version overlap window: vN ships with the gate disabled by default but the wiring in place. vN+1 flips the default. Existing installs get a `unbrowse setup` nudge on first failed write.
2. Telemetry from un-keyed installs continues uploading (we still want to see the failure shape), but tagged `auth_state: "unkeyed"` so triage can sort.
3. CHANGELOG entry must be loud — this is a breaking change for anonymous publishers.

**What stays open even with the gate on (read paths):**

- `unbrowse_resolve` — agents must be able to query the marketplace without an account to discover Unbrowse exists.
- `unbrowse_execute` against already-published skills — TBD; likely gated behind a free-tier sponsor allowance (existing `sponsor.ts` machinery), then requires a key past that.
- `unbrowse_health`, `unbrowse_skills` listing — always open.

**Open questions (revisit when Phase 4 is scheduled):**

1. OAuth vs magic-link vs CLI device-code for `unbrowse setup` key collection? Device-code is cleanest for headless installs.
2. Do we machine-issue per-agent sub-keys so a single account can run many parallel installs without sharing one key? Probably yes — extends Unkey's per-key namespacing already in place.
3. Does the API-key-fp in telemetry let users opt out of account-linked clustering even when keyed? Yes — `telemetry.link_account: false` in config keeps the fp omitted.
4. How do we handle existing installs that have published things — grandfather them, or force re-auth? Probably grandfather reads, require key for new writes.

---

## 2026-05-14 update — actual implementation choices

The Phase 3 backend landed with two deviations from the original plan above; updating the doc so future contributors see the truth:

- **Storage: Neon Postgres via `DATABASE_URL`**, NOT Cloudflare D1. The codebase already binds Neon for `app_kv`, agent state, and traction metrics; adding a second storage path for one route was not worth the operational cost. Schema lives at `backend/schema/telemetry-sessions.sql`, applied via `DATABASE_URL=... node backend/scripts/migrate-telemetry-schema.mjs`. Tables: `telemetry_sessions` (JSONB events_json), `telemetry_clusters` (cluster_key PK + github_issue_url).
- **Issue staging: GitHub Issues directly on `unbrowse-ai/unbrowse-dev`**, NOT Linear inbox. Same destination Lewis would have curated to anyway — skipping the staging hop saves a Linear project setup and an auth surface. Issues are opened with label `triage-needed` via the GitHub Issues API. Token resolution: `GITHUB_TRIAGE_TOKEN` first, falls back to the existing `GITHUB_PR_BOT_TOKEN`. Repo override: `GITHUB_TRIAGE_REPO=owner/repo`.

Everything else in the plan (sanitisation rules, reflection nudge surfaces, hardcoding guards, opt-out endpoint, anti-pattern list) ships as specified.

The original "Linear inbox → curate → promote to GitHub" workflow is moot — clusters that meet the promotion threshold open GitHub issues immediately. The maintainer's job is now to read the `triage-needed` queue weekly and either fix or close (auto-closing handled via standard GitHub stale-bot if we want it).
