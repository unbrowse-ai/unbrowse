# Phase 2 scope — per-module server-move (DEV-ONLY; describes backend + moat)

Confirmed for server-move: `graph`, `indexer`, `reverse-engineer`. Each follows the
proven **ranking WAVE-2 template**, one reviewed checkpoint per module.

## The template (from `src/ranking/index.ts` ↔ `backend/src/routes/search.ts`)
- **Client:** `xServerFirst(input)` builds a `local()` fallback closure, calls `xRemote()`
  which POSTs **sanitized** input to a `/v1/…` route (returns `null` on non-payment
  failure → transparent fallback; throws only on x402). Server is authoritative when it
  returns a usable result; otherwise local decides.
- **Backend:** Hono `post()` under `app.route("/v1", …)` with `bearerAuth, requireSignedClient`;
  parse JSON → validate → **bound payload** → call a `services/*` function → return JSON
  with a `degraded` flag. (Mirror `/search/rank` in `backend/src/routes/search.ts` +
  `backend/src/services/rank.ts`.)

The big local function STAYS in the client as the degraded fallback — the move is wiring
the route + the server-first wrapper + switching the **agent-facing** callers to it.

---

## ① graph → `/v1/graph/compile`   — CLEAN, do FIRST
- **Entrypoint:** `buildSkillOperationGraph(endpoints: EndpointDescriptor[])` /
  `ensureSkillOperationGraph(skill)` (`src/graph/index.ts`). Callers: `src/indexer/`,
  `src/graph/session.ts`, `src/client/`.
- **Input is already sanitized** — `EndpointDescriptor[]` is published skill metadata, no
  secret values. **Safe to send as-is** (same property the ranking move relied on).
- **Backend:** add `POST /v1/graph/compile` (mirror `/search/rank`) → service wraps
  `buildSkillOperationGraph`. Bound endpoints[] (≤500).
- **Client:** add `buildSkillOperationGraphServerFirst()` → `graphCompileRemote()` POST →
  fallback to local `buildSkillOperationGraph`. Switch the agent-facing graph build
  (indexer publish path + session planning) to server-first; keep local as fallback.
- **Risk:** LOW (sanitized input). **Effort:** medium. **Why first:** proves the
  *compilation* template with zero security surface.
- **Done:** agent-facing graph build hits `/v1/graph/compile` primary; local only on
  fallback. Debt row `graph` → `resolved`.

## ② indexer → `/v1/index/admit`   — MEDIUM, do SECOND
- **Entrypoint:** `queueBackgroundIndex(job)` (`src/indexer/index.ts`). Callers: `src/cli.ts`,
  `src/orchestrator/`.
- **Mostly genuinely client-local** — the queue + local disk-snapshot write stay client.
  The moat parts are (a) the **graph build** (delegated once ① lands) and (b) any
  **admission/scoring** intelligence.
- **Action:** after ① ships, indexer's graph-build delegates automatically. Then decide:
  if admission/scoring is real moat → `/v1/index/admit`; if it's just local cache
  bookkeeping → **reclassify the local queueing as `client-local`** (honest down-classify,
  not a move).
- **Risk:** LOW. **Effort:** low–medium (leans on ①).
- **Done:** moat scoring server-first OR module reclassified client-local with evidence.
  Debt row `indexer` → `resolved`.

## ③ reverse-engineer → `/v1/capture/infer`   — HARD, do LAST (security gate)
- **Entrypoint:** `extractEndpoints(requests: RawRequest[])` (`src/reverse-engineer/index.ts`).
  Caller: `src/capture/index.ts`.
- **🚨 BLOCKER — this is NOT a plain template apply.** `extractEndpoints` runs on **RAW
  captured traffic** that contains the user's **cookies, auth headers, tokens, secret
  values**. Sending `RawRequest[]` to the backend would **ship credentials off the machine
  — a direct violation of "credentials never leave your machine."** The ranking/graph moves
  are safe only because their input was already sanitized; this input is NOT.
- **Required design (before any code):**
  1. A **local sanitization pass** strips secrets first — reuse the existing
     `isSensitiveHeader` / `isReplayCriticalHeader` / `extractAuthHeaders` surface in this
     module to redact cookies/auth/token values, leaving only **structural signal**
     (methods, URL shapes, param keys, response schemas — no secret bytes).
  2. Only the sanitized signal goes to `/v1/capture/infer`, which runs the RE intelligence
     server-side and returns `EndpointDescriptor[]`.
  3. The local `extractEndpoints` stays as the degraded fallback.
- This needs a written **sanitization contract** + review — the RE heuristics are the
  deepest moat AND the most secret-adjacent code in the client.
- **Risk:** HIGH (security). **Effort:** high. **Gate it hardest** — sanitization must be
  proven (a test asserting no secret value crosses the wire) before the route is wired.
- **Done:** sanitized-signal server-first path + a witness test proving zero secret leakage.
  Debt row `reverse-engineer` → `resolved`.

---

## Sequencing & next checkpoint
**graph → indexer → reverse-engineer.** Recommended next: **① graph** — clean, no security
surface, proves the compilation template end-to-end (backend route + client server-first +
fallback + a test). Each module is a separate reviewed checkpoint that flips its debt row
to `resolved` and keeps `scripts/client-boundary-gate.sh` green throughout.

## Standing guardrails (unchanged)
- The big local functions stay as degraded fallbacks — never delete the offline path.
- No raw-traffic / secret bytes cross the wire — sanitize locally first (esp. ③).
- Backend lives in this monorepo under `backend/` (private, not synced public).
- This scope doc + the manifest are **dev-only** (`scripts/boundary/`), never `docs/`.
