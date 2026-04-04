# External Integrations

**Analysis Date:** 2026-04-01

## Browser Engine — Kuri

**What it is:** A Zig-native Chrome DevTools Protocol (CDP) broker. Replaces Playwright/Puppeteer for all browser automation. 464KB binary, ~3ms cold start (versus 80–150MB and 1–3s for Playwright).

**Client:** `src/kuri/client.ts` — 889 lines, thin HTTP wrapper over Kuri's REST API

**How it works:**
- Kuri binary launches and manages Chrome headless; the Node.js client communicates with it over HTTP on port 7700 (default, configurable)
- `kuri.start()` spawns the Kuri process and Chrome; `kuri.stop()` tears them down
- All CDP operations (navigate, click, fill, scroll, HAR capture, screenshot, cookie injection, etc.) go through Kuri's REST endpoints — no Node.js CDP bindings or Playwright API

**Binary locations:**
- Vendor path (npm package): `packages/skill/vendor/kuri/{platform}/kuri`
  - `darwin-arm64/kuri`, `darwin-x64/kuri`, `linux-arm64/kuri`, `linux-x64/kuri`
- Build source: `submodules/kuri/` (git submodule, branch `adding-extensions`)
- Build command: `zig build -Doptimize=ReleaseFast -Dtarget={zig-triple}`

**Discovery at runtime:** `src/runtime/paths.ts` — `getPackageRoot()` walks up from `import.meta.url` to find `package.json`, then resolves `vendor/kuri/{platform}/kuri`. Overridable via `UNBROWSE_PACKAGE_ROOT` env var.

**Key Kuri API surface (from `src/kuri/client.ts`):**
- `GET /health` — readiness check
- `POST /tab` — open a new browser tab
- `DELETE /tab/:id` — close tab
- `POST /navigate` — navigate to URL
- `POST /action` — browser action (click, fill, type, select, hover, scroll, press, etc.)
- `POST /wait` — wait for selector or network idle
- `GET /url` / `GET /html` — current URL / page HTML
- `POST /har` — retrieve captured HAR entries
- `POST /cookies` — get/set cookies via CDP
- `POST /screenshot` — take screenshot

**Timeouts:**
- Startup: `KURI_STARTUP_TIMEOUT_MS = 10_000`
- Per request: `KURI_REQUEST_TIMEOUT_MS = 30_000`
- Spawn retries: 3 attempts with 1s delay

**Capture concurrency:** max 3 concurrent capture tabs (`MAX_CONCURRENT_TABS = 3` in `src/capture/index.ts`)

---

## Marketplace / Registry API — beta-api.unbrowse.ai

**Base URL:** `https://beta-api.unbrowse.ai` (configurable via `UNBROWSE_BACKEND_URL` or `UNBROWSE_API_URL`)

**Auth:** Bearer token in `Authorization` header. API key stored in `~/.unbrowse/vault/` or macOS keychain.

**Client modules:**
- `src/client/index.ts` — skill CRUD, agent registration, local cache
- `src/client/graph-client.ts` — graph/chain resolution, session recording, negative signals

**Key API routes consumed by the skill engine:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/skills` | List published skills |
| `GET` | `/v1/skills/:id` | Fetch one skill |
| `POST` | `/v1/skills` | Publish a new skill |
| `GET` | `/v1/search` | Intent-based skill search |
| `POST` | `/v1/graph/chain` | Resolve prerequisite chain for an endpoint |
| `GET` | `/v1/graph/predict/:domain` | Co-occurrence predictions |
| `POST` | `/v1/graph/session` | Record a session action (fire-and-forget) |
| `POST` | `/v1/graph/negative` | Report an explicit negative signal |
| `POST` | `/v1/stats/:skillId/endpoints/:epId` | Update endpoint reliability score |
| `POST` | `/v1/agents/register` | Register agent identity |

**Local cache:** Skills are pre-cached locally before remote publish so the agent can use them immediately even if the backend is slow or down (`src/marketplace/index.ts`).

**Timeout:** Graph API calls use `UNBROWSE_GRAPH_TIMEOUT_MS` (default 4000ms) with `AbortController`.

---

## Backend — Cloudflare Workers

**Runtime:** Cloudflare Workers (V8 isolates, no Node.js), deployed to `beta-api.unbrowse.ai`

**Framework:** Hono `^4.7.0`

**Entry point:** `backend/src/index.ts`

**Deployment:** `wrangler deploy` via `backend/wrangler.toml`
- Production route: `beta-api.unbrowse.ai/*` (zone `73934a4d815fde770167414fc3ead04b`)
- Staging: `unbrowse-backend-staging.workers.dev`

**Cloudflare bindings used:**
- `STATS_KV` — KV namespace for skill manifests, BM25 indexes, agent profiles, stats, search cache

**Backend route groups (`backend/src/routes/`):**
- `health.ts` — `GET /health`
- `skills.ts` — skill CRUD (public reads, authenticated writes)
- `search.ts` — intent search (vector + BM25 hybrid)
- `stats.ts` — execution stats
- `analytics.ts` — usage analytics
- `agents.ts` — agent registration and profiles
- `issues.ts` — skill issue reporting
- `graph.ts` — DAG chain resolution and session recording
- `telemetry.ts` — install/execution telemetry ingestion
- `fees.ts` — skill pricing queries
- `ops.ts` — operational endpoints (reindex, etc.)

---

## EmergentDB (Vector Search + KV Cache)

**Base URL:** `https://api.emergentdb.com`

**Used by:** `backend/src/services/discovery.ts`

**Authentication:** `EMERGENTDB_API_KEY` env var (Cloudflare Worker secret)

**What it provides:**
- Vector embedding and semantic search: `/graph/search`, `/graph/batch_insert`, `/graph/delete`
  - Auto-embeds query and documents server-side (no local embedding needed)
  - Two namespaces indexed per skill: domain-specific and global (`domain` / `global`)
- Distributed KV cache (`/qdkv/get`, `/qdkv/set`) — used to cache search results for 5 minutes

**Search strategy (hybrid):** EmergentDB vector search fused with in-process BM25 (stored in Cloudflare KV under `bm25-idx:{domain}`) using Reciprocal Rank Fusion (RRF k=60). Results rescored by composite formula: 40% embedding similarity + 30% reliability + 15% freshness + 15% verification ratio.

---

## Unkey (API Key Management)

**URL:** `https://api.unkey.com/v2/keys.verifyKey`

**Used by:** `backend/src/middleware/auth.ts`

**What it provides:** API key issuance and verification for the marketplace backend. Every authenticated request to `/v1/skills` (writes) and `/v1/stats` verifies the Bearer token against Unkey.

**Secrets:**
- `UNKEY_ROOT_KEY` — root key for verifying tokens
- `UNKEY_API_ID` — API ID (also in `backend/wrangler.toml` as a plain var: `api_4zrwAzybN7mVTKbw`)

**Behavior:** Staging environment bypasses Unkey (accepts any Bearer token).

---

## Nebius (LLM — Endpoint Description Generation)

**URL:** `https://api.tokenfactory.nebius.com/v1/chat/completions`

**Model:** `moonshotai/Kimi-K2.5`

**Used by:** `backend/src/services/descriptions.ts`

**What it does:** During `publishSkill()`, generates human-readable descriptions for API endpoints that lack them. Descriptions power BM25 and vector matching so the orchestrator can select the right endpoint for a given intent. Falls back to heuristic (camelCase splitting + schema key listing) if the LLM call fails.

**Auth:** `NEBIUS_API_KEY` (Cloudflare Worker secret)

---

## x402 Payments (Skill Access Gating)

**Facilitator:** `https://facilitator.corbits.dev`

**Used by:** `backend/src/middleware/x402-gate.ts`

**Protocol:** HTTP 402 Payment Required flow
1. Client requests gated resource
2. Server returns 402 with `X-Payment-Required` header containing payment terms
3. Client pays via Corbits facilitator (USDC on `base-sepolia`)
4. Client retries with `X-Payment-Proof` header
5. Server verifies proof against Corbits

**Payment terms:** USDC on `base-sepolia` chain; recipient wallet configured via `PAYMENT_RECIPIENT` env var.

**Graceful degradation:** If Corbits is unreachable (5s timeout), the middleware allows the request through rather than blocking.

---

## Chrome / Firefox Cookie Extraction (SQLite)

**Module:** `src/auth/browser-cookies.ts`

**What it does:** Reads browser cookies directly from SQLite databases on disk without launching the browser. Used to inject auth cookies into captured requests for gated sites.

**Supported browsers:**
- **Firefox:** Reads `moz_cookies` table from `{profile}/cookies.sqlite` (unencrypted)
  - macOS: `~/Library/Application Support/Firefox/Profiles/{profile}/cookies.sqlite`
  - Linux: `~/.mozilla/firefox/{profile}/cookies.sqlite`
  - Windows: `%APPDATA%/Mozilla/Firefox/Profiles/{profile}/cookies.sqlite`
- **Chrome/Chromium:** Reads `cookies` table from `{profile}/Network/Cookies` or `{profile}/Cookies` (encrypted)
  - macOS decryption: Retrieves key from keychain via `security find-generic-password -s "Chrome Safe Storage"`, then PBKDF2-SHA1 → AES-128-CBC
  - Linux/Windows decryption: Not yet implemented

**SQLite access:** Copies the DB to a temp dir (`mkdtemp`) before querying (so Chrome can be open). Uses the `sqlite3` CLI binary (must be on PATH).

**Auto-detect order:** Firefox first (no decryption needed), then Chrome default profile.

---

## OS Keychain / Credential Vault (keytar)

**Module:** `src/vault/index.ts`

**Primary:** `keytar ^7.9.0` (optional npm dependency) — stores/retrieves credentials from the OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Manager) under service name `"unbrowse"`

**Fallback (when keytar is unavailable):** AES-256-CBC encrypted JSON file at `~/.unbrowse/vault/credentials.enc` with random key at `~/.unbrowse/vault/.key` (mode 0600)

**Used for:** Storing API keys and auth tokens (session cookies, OAuth tokens) so they persist across CLI invocations without re-authentication.

---

## Frontend — Cloudflare Pages

**Location:** `frontend/`

**Framework:** Next.js 16.1.5 + React 19 + Tailwind v4

**Deployment adapter:** `@opennextjs/cloudflare ^1.15.1`

**Deploy command:** `opennextjs-cloudflare build && opennextjs-cloudflare deploy`

**Dev command:** `next dev`

---

## Release Pipeline

**Tool:** `release-it ^19.2.4` with plugins:
- `@release-it/bumper ^7.0.5` — bumps version in `package.json`, `packages/skill/package.json`, `version.json` simultaneously
- `@release-it/conventional-changelog ^10.0.5` — generates `CHANGELOG.md` from conventional commits

**Release flow (`bun run release`):**
1. Pre-init: runs unit tests (`bun test tests/path-params.test.ts tests/utils.test.ts`)
2. Bumps version across all three files
3. After bump: runs `scripts/sync-skill-md.ts`, `scripts/generate-release-notes.ts`, `scripts/release-announce.ts --write`
4. Creates git tag `v{version}` and GitHub Release using `.release-notes.md` as body
5. Tag push triggers CI for backend and frontend deployment and syncs the public skill repo (`unbrowse-ai/unbrowse`) via `bash scripts/sync-skill.sh`

**Config:** `.release-it.json`

**Required secrets for releases:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SKILL_REPO_TOKEN`

---

## Local Telemetry (Trace Storage)

**Module:** `src/telemetry.ts`

**What it does:** Writes anonymized `RouteTraceArtifact` JSON files to `~/.unbrowse/traces/` after each orchestration. Used for future ML training (RAG, contextual bandits, KGE extraction).

**Anonymization rules enforced in code:**
- Never stores: raw cookies, auth tokens, CSRF tokens, full request/response bodies, PII
- Stores: normalized binding names, hashed binding values (SHA-256, 16-char hex), response schema shape, response hashes, route fingerprints, error taxonomy labels

**Opt-out:** `UNBROWSE_DISABLE_TRACES=1`

---

## GitHub Integration

**CI/CD:** GitHub Actions (triggered by tag push)
- Deploys backend (Cloudflare Workers) and frontend (Cloudflare Pages)
- Syncs and releases the public `unbrowse-ai/unbrowse` skill package

**PR/issue creation:** `gh` CLI (no direct push to main; PRs only)

---

*Integration audit: 2026-04-01*
