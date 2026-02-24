# Changelog

## Fix: Endpoint ranking noise filter and data-relevance scoring

### Bug fix
- **Comprehensive noise host filtering in rankEndpoints**: The endpoint auto-selector was choosing ad trackers, consent managers, and analytics endpoints (id5-sync, btloader, onetrust, adsrvr, googlesyndication, etc.) over actual data endpoints. Added a NOISE_HOSTS blocklist matching 30+ known noise domains, aligned with the reverse-engineer's existing `SKIP_HOSTS` filter.
- **Off-domain penalty (-20)**: Endpoints hosted on third-party domains now receive a -20 score penalty instead of just missing the +15 on-domain bonus. This prevents ad/tracking endpoints from outranking on-domain data.
- **Auth/config path penalty (-15)**: On-domain noise like `/csrf_meta`, `/logged_in_user`, `/analytics_user_data`, `/onboarding` paths are now penalized.
- **Meta/support path penalty (-10)**: Supplementary endpoints like `/insight_annotations`, `/sentiment_votes`, `/portfolio/summary_card` are demoted in favor of actual data endpoints.
- **Currency/time path bonus (+12)**: Paths containing currency codes (`/usd`, `/eur`, `/btc`) or time ranges (`/24_hours`, `/7_days`, `/daily`) get a relevance boost for price/financial intents.
- **Data format bonus (+5)**: Endpoints with `.json`/`.xml`/`.csv` extensions or `/api/` paths get a small lift.

## BUG-005: Captured query params not applied during skill execution

### Bug fix
- **Query params now merged into URL during execution**: When an endpoint was captured with query parameters (e.g. `?query=FDRY`), the reverse-engineer correctly stored them in `endpoint.query`, but `executeEndpoint()` never applied them to the outbound request URL. This caused 400 errors for any endpoint that required query parameters. Now merges `endpoint.query` into the URL via `URL.searchParams`, with user params overriding captured defaults.

## Fix: Skill Publishing Race Condition

- **Backend returns full manifest on publish**: `POST /v1/skills` now returns the complete skill manifest instead of just `{ skill_id, version }`, eliminating the read-after-write round-trip that failed due to EmergentDB eventual consistency.
- **KV write errors surfaced**: `putBatch()` now checks `qdkv/set` response status and throws on failure instead of silently ignoring write errors.
- **Client uses returned manifest**: Local `publishSkill()` no longer re-fetches from backend after publishing, fixing "Published skill not found in backend after retries".


### Breaking changes
- **Registration now requires ToS acceptance**: `POST /v1/agents/register` requires a `tos_version` field matching the current version. Requests without it receive a 400 error with instructions.
- **All local routes gated behind API key**: The local Fastify server now returns 401 on all routes (except `/health`) when no API key is configured.
- **Existing agents must re-accept ToS**: Agents registered before this change will receive a 403 `tos_update_required` error on authenticated requests until they accept the current ToS.

### New features
- **ToS version tracking**: Agent profiles now store `tos_accepted_version` and `tos_accepted_at`. When ToS is updated, agents must re-accept before their key works.
- **CLI ToS prompt**: On first startup (or when ToS is updated), the CLI displays a ToS summary and prompts for explicit acceptance before proceeding.
- **`GET /v1/tos/current`**: New public endpoint returning the current ToS version, summary, and URL.
- **`POST /v1/agents/accept-tos`**: New authenticated endpoint for re-accepting updated ToS.
- **Frontend ToS checkbox**: The API key generator now requires checking a ToS agreement checkbox before registration.

## Legal Entity & Terms of Service

- Added Terms of Service page (`/terms`) establishing Unreel AI Pte Ltd as the legal entity operating unbrowse
- Updated Privacy & Data Sharing page to reference Unreel AI Pte Ltd
- Added copyright notice and entity attribution to site footer
- Added Terms link to footer navigation

## Security & Legal Hardening

### Marketing language
- Removed "bypass the need for official API documentation" and "discover hidden APIs" from all docs
- Replaced with neutral language: "discover API endpoints", "work without official API documentation"

### Data privacy
- `recordExecution()` no longer sends `trace.result` (actual API response data) to the backend — only metadata (success, status_code, latency, drift) is transmitted for scoring

### Network security
- Default bind address changed from `0.0.0.0` to `127.0.0.1` — server is localhost-only by default

### Credential sanitization
- Added `x-api-key`, `api-key`, `x-auth-token`, `x-app-key`, `x-app-secret` to header strip list
- Added prefix stripping for `x-auth-*`, `x-amz-security-*`, `x-stripe-*`, `x-firebase-*`
- Added catch-all: any header containing `token`, `key`, `secret`, `credential`, or `password` is stripped (unless on the safe-header allowlist)
- New: query parameters with sensitive names (`api_key`, `access_token`, `secret`, etc.) are stripped from URL templates before publishing

### Licensing
- Expanded LICENSE to full MIT text with copyright notice
- Added LICENSE file to packages/skill/ for the published repo

---

## Documentation: Surface Marketplace & Community Features

SKILL.md, README.md, and packages/skill/README.md previously described unbrowse as a local-only tool. Updated all docs to surface the shared marketplace architecture.

### SKILL.md
- Rewrote overview to describe marketplace-first architecture
- Added "How Intent Resolution Works" section (orchestrator priority chain, composite scoring)
- Added "Reporting Issues" section with API example and category list
- Added "Endpoint Selection" section (merged from packages/skill variant)
- Added `/v1/search/domain` and issue routes to API reference table
- Removed "(proxied to beta API)" noise from route table
- Expanded feedback section to explain auto-deprecation consequences
- Added rule about issue reporting

### README.md
- Added "How it works" section explaining local + marketplace hybrid architecture
- Added "Architecture" section covering backend components (KV, EmergentDB, Gemini, Unkey, scoring)
- Added "Marketplace" section covering discovery, lifecycle, reliability scoring, issues, agents
- Added `~/.unbrowse/config.json` to data directories
- Added `UNBROWSE_API_KEY` to environment variables

### packages/skill/
- Updated README.md opening description and "How it works" to mention shared marketplace
- Added "Marketplace" section with auto-registration details
- Converted SKILL.md to symlink pointing to root SKILL.md (single source of truth)

---

## DOM Fallback Extraction

When no API endpoints are discovered (SSR sites, static pages, JS-rendered content with no XHR), unbrowse now automatically falls back to extracting structured data from the rendered DOM.

### New `src/extraction/` Module
- **`cleanDOM(html)`:** Strips scripts, styles, nav/footer chrome, ads, hidden elements. Prefers content inside `<main>`, `<article>`, `[role="main"]`
- **`parseStructured(html)`:** Heuristic extraction of tables, lists, repeated card patterns, definition lists, JSON-LD, and Open Graph meta tags
- **`extractFromDOM(html, intent)`:** Scores extracted structures by relevance to user intent, returns best match with confidence score

### Capture Layer
- `captureSession()` now returns rendered HTML (`html` field on `CaptureResult`) via `page.content()` before closing the browser

### Execution Layer
- When `extractEndpoints()` finds 0 API endpoints, the execution layer now tries DOM extraction, **publishes a DOM skill** with the mapping, and returns structured data
- **HTML post-processing:** when any endpoint returns HTML instead of JSON, it's automatically piped through `extractFromDOM()` to produce structured data (source: `html-postprocess`)
- DOM extraction results include `_extraction` metadata (method, confidence, source)
- Orchestrator tracks `"dom-fallback"` as a distinct result source alongside `"marketplace"` and `"live-capture"`
- **Agent-driven endpoint selection:** responses now include `available_endpoints` listing all discovered endpoints so the calling agent can pick the right one and retry with `endpoint_id` if the auto-selected one is wrong
- Static asset URLs (`.woff`, `.css`, `.js`, `.png`, etc.) are now filtered from endpoint candidates
- Endpoints with `dom_extraction` metadata are preferred by the auto-selector (+25 score)

---

## Chrome Cookie Extraction, Direct HTTP Execution & CSRF Support

### Chrome Cookie Extraction (macOS)
- **`extractChromeCookies(domain)`:** Reads cookies directly from Chrome's SQLite database at `~/Library/Application Support/Google/Chrome/Default/Cookies`, decrypts using the Chrome Safe Storage key from macOS Keychain (PBKDF2 + AES-128-CBC)
- **`yoloExtract(domain)`:** One-call auth — extracts and stores cookies in the vault with yolo flag. No browser launch, no profile locks, instant
- **Clean filtering:** Only extracts exact domain matches (`.x.com`, `x.com`), rejects cookies with non-printable characters from incomplete decryption
- **Wired into `/v1/auth/login`:** When `yolo: true` on macOS, uses cookie extraction first before falling back to browser-based login

### Direct HTTP Execution
- **Skip browser for API calls:** When auth cookies exist and the endpoint URL contains `/api/`, uses `fetch()` directly instead of launching a browser. Eliminates headless detection issues (HeadlessChrome in sec-ch-ua)
- **Cookie header construction:** Builds cookie header from vault cookies for direct HTTP requests

### CSRF Auto-Injection
- **`csrf_plan` support:** If an endpoint has a `csrf_plan`, extracts the named cookie and sets it as `x-csrf-token` header
- **x.com heuristic:** Automatically injects `ct0` cookie as `x-csrf-token` when endpoint uses `x-twitter-auth-type`

### Other Improvements
- **Fixed vault location:** Changed from `process.cwd()/.vault/` to `~/.unbrowse/vault/` so vault works regardless of server CWD
- **Endpoint targeting:** Added `endpoint_id` param to `executeSkill` to bypass auto-endpoint selection
- **URL-safe interpolation:** Query string params are now `encodeURIComponent`-encoded during URL template interpolation
- **Exported Chrome helpers:** `getMainChromeProfilePath`, `getChromeUserDataDir`, `getChromeExecutablePath` now exported for use by capture module
- **Yolo flag in vault:** Stored alongside cookies so capture module can detect yolo-authenticated domains
- **`isYoloAuth(domain)`:** Checks if a domain was authenticated via yolo mode

---

## Yolo Mode: Use Main Chrome Profile for Login

- **Yolo login:** `POST /v1/auth/login` now accepts `"yolo": true` to open the user's real Chrome browser with their existing sessions — no re-login needed for sites they're already authenticated on
- **Chrome detection helpers:** Cross-platform (macOS/Windows/Linux) helpers to find Chrome's profile path, executable, and check if Chrome is running via `SingletonLock`
- **Safety checks:** Returns clear errors if Chrome isn't installed or is currently running (Playwright can't share the profile lock)
- **Skill docs updated:** All three SKILL.md files updated with yolo login instructions and the required user consent prompt

---

## WebSocket Capture, Endpoint Filtering & Validator Fixes

### WebSocket Support
- **CDP-based WebSocket capture:** Hook `Network.webSocketCreated`, `webSocketFrameReceived`, `webSocketFrameSent` via Chrome DevTools Protocol to capture real-time WS traffic during browser sessions
- **WS endpoint extraction:** Group captured messages by URL, infer response schemas from received JSON frames, create `method: "WS"` endpoints with `ws_messages` array
- **WS execution:** Connect to WebSocket endpoints, collect messages for 7s, parse JSON, apply projection
- **Type updates:** Added `"WS"` to `EndpointDescriptor.method` union and `WsMessage` interface in both `src/types/skill.ts` and `backend/src/types.ts`

### Backend Validator Fixes
- **Accept WS method:** Added `"WS"` to `VALID_METHODS` in `backend/src/services/validator.ts`
- **Accept wss:// URLs:** Changed `URL_RE` from `/^https?:\/\//` to `/^(https?|wss?):\/\//`
- **Local workaround:** Strip WS endpoints before publishing to remote backend (pending deployment) — keeps WS endpoints for local execution

### Endpoint Filtering Improvements
- **Fixed SKIP_EXTENSIONS regex:** Changed `$` anchor to `([?#]|$)` so URLs with query strings are properly filtered (`.js?v=hash`, `.css?t=123`)
- **Added SKIP_PATHS:** Filter `/_next/static/`, `/static/chunks/`, `/static/media/`, `/cdn-cgi/` paths
- **Added CDN image path filter:** Skip `/coin-image/`, `/avatar/`, `/profile-image/` paths
- **Expanded SKIP_HOSTS:** Added 16 new infrastructure/telemetry domains: datadoghq, fullstory, launchdarkly, intercom, privy, mypinata, sentry, segment, amplitude, mixpanel, hotjar, clarity, googletagmanager, walletconnect, imagedelivery, cloudflareinsights

### Endpoint Selection Improvements
- **Domain affinity scoring:** `selectBestEndpoint` now takes `skillDomain` param and adds +15 score for endpoints on the skill's own domain (prevents selecting third-party CDN/analytics endpoints)
- **WS schema bonus:** WS endpoints with response schemas get +3 score

---

# Previous Changes

**Base commit:** `f1bd8e3` — "fix: resolve GC-001 through GC-008 and GC-012"
**Current:** `334bf51` + uncommitted changes
**Files changed:** 32 files, +987 / -205 lines (committed) + ~113 lines uncommitted

---

## Agent Identity, Issue Reporting & Agent-First Frontend

### Backend: Agent Identity via Unkey
- **Unkey integration:** API key management via Unkey REST API (v2). Keys prefixed `ubr_`, verified on every request. Agent profiles stored in `STATS_KV`.
- **Auth middleware rewrite:** Dual-check legacy admin key OR Unkey-verified agent keys, sets `agent_id` in Hono context. Added `optionalAuth` for public-but-identity-aware routes.
- **Agent service:** `registerAgent()` creates Unkey key + KV profile. `incrementAgentExecutions()`, `incrementAgentFeedback()`, `addSkillDiscovered()` track contributions.
- **Agent routes:** `POST /v1/agents/register` (public), `GET /v1/agents/me` (auth), `GET /v1/agents/:id` (public), `GET /v1/agents` (public)
- **Stats summary:** `GET /v1/stats/summary` now includes `agents` count
- Backward-compatible: existing `UNBROWSE_API_KEY` env continues to work

### Backend: Issue Reporting
- **Issue service:** Agents can report problems with skills for repair. Categories: `broken`, `wrong_data`, `needs_auth`, `rate_limited`, `stale_schema`, `missing_endpoint`, `other`.
- **Issue routes:** `POST /v1/skills/:id/issues` (auth), `GET /v1/skills/:id/issues` (public), `PATCH /v1/skills/:id/issues/:issue_id` (admin)
- Issues stored in `STATS_KV` with per-skill index (capped at 100)

### Frontend: Agent-First Onboarding
- **Auth context:** `auth-context.tsx` — localStorage-backed API key management
- **Landing page:** Added "Get Your API Key" onboarding section with registration API docs, interactive key generator, tabbed install instructions (Claude Code, Cursor, cURL, Python)
- **New components:** `ApiKeyGenerator`, `InstallInstructions`
- **New pages:** `/dashboard` (agent profile + stats), `/skills/[id]` (skill detail + endpoints), `/agents/[id]` (public agent profile)
- **Updated:** Navbar (Dashboard link), StatsStrip (agents count), Footer (Dashboard link)

### CLI Client
- Added `registerAgent()`, `getAgent()`, `getMyProfile()` in `src/client/index.ts`

---

## Committed Changes (8 commits)

### 1. Frontend: Full Landing Page Revamp (`e2f4711`)
- Replaced the entire landing page with a new design
- **Constellation background** — animated particle system with mouse interaction
- **Interactive chat demo** — shows an Airbnb API discovery flow step-by-step
- Streamlined from many sections down to 5: hero, demo, how-it-works, architecture, CTA
- Removed bloated sections (stats strip, endpoint cards, flywheel, example output)
- Added **privacy & data sharing page** (`/privacy`)
- Replaced text logos with anvil logo + full favicon set
- Defaulted to dark theme
- Updated install command to `npx skills add https://github.com/getfoundry/unbrowse --skill unbrowse`
- Darkened the CSS color palette (surface, border, glow values)

### 2. Live Stats Strip & Value Prop Cards (`f27c9d8`)
- **New public endpoint:** `GET /v1/stats/summary` — returns skills, endpoints, domains, executions counts
- Split stats routes into public (summary) and protected (execution/feedback)
- Added 3 value prop cards: save money (40x fewer tokens), save time (100x faster), make money (any site = API)
- Added **StatsStrip** component fetching real counts from the backend
- Added **NVIDIA Inception badge** in footer
- Fixed GitHub URLs: `anthropics/unbrowse` → `getfoundry/unbrowse`

### 3. Backend CORS & Public Routes (`7baae52`, `8ca2989`)
- Added global CORS middleware (`origin: *`, all methods)
- Made search routes public (no auth required)
- Added explicit `Access-Control-Allow-Origin` header on stats summary
- Reduced stats cache from default to 60s

### 4. Headed Capture & GraphQL Dedup (`9d4647a`)
**Capture improvements:**
- Always use persistent browser profile in **headed mode** (not headless) for auth-gated sites like LinkedIn
- Hook `page.on('response')` BEFORE navigation to catch all XHR/fetch during initial load
- Broadened response body capture: now includes `text/plain`, protobuf, `batchexecute`, `/api/` paths
- Increased settle wait from 2.5s to 5s for SPAs like Google Trends

**Reverse-engineer improvements:**
- Preserve `queryId` param in GraphQL URL normalization so different queries aren't deduped
- Strip Google-style JSON prefixes (`)]}'`) before parsing response bodies
- Added `batchexecute` and `/api/` to RPC hint patterns
- Skip endpoints with invalid (non-http) URL templates

**Other:**
- Hardcoded backend API URL to `https://beta-api.unbrowse.ai`
- Generate `skill_id` with `nanoid()` in draft to fix backend validation
- Raised confidence threshold from 0.25 to 0.5

### 5. Remove DELETE Skills Route (`334bf51`)
- Removed `DELETE /v1/skills/:id` — skills should not be deletable via API
- Cleaned up unused `deprecateSkill` import

### 6. Bug Fixes (`baf28f6`, `0af0908`)
- Added `POST /v1/feedback` route (proxies to backend, accepts both `skill_id` and `target_id`)
- Fixed logger import paths (`./logger.js` to `../logger.js`) in auth and capture modules
- Removed duplicate `har_lineage_id` declaration
- Removed extra closing brace in `interactiveLogin()`
- Added `beta.unbrowse.ai` route to wrangler config
- Fixed `tsconfig.json`

---

## Uncommitted Changes (working tree)

### 7. Make Read Routes Public, Keep Writes Protected
- **Skills routes split:** `GET /skills`, `GET /skills/:id`, `GET /skills/:id/endpoints/:eid/schema` are now public (no auth)
- Only `POST /skills` and `PATCH /skills/:id/endpoints/:eid` still require auth
- **Validate route made public:** `POST /v1/validate` moved out of auth-protected group

### 8. API Client Auth Flag
- Added `auth` parameter to the `api()` helper in `src/client/index.ts`
- Read-only calls (GET) no longer send `Authorization` header
- Write calls (`POST`, `PATCH`, `DELETE`) explicitly pass `auth = true`

### 9. KV Fallback Search in Discovery
- Vector search (`searchIntent`, `searchIntentInDomain`) now catches errors and falls back to **keyword search over KV**
- New `kvFallbackSearch()` does term matching against skill name, intent_signature, description, and domain
- Changed global namespace from `unbrowse--global` to `unbrowse-skill`

### 10. Confidence Threshold Tuned Down
- Lowered confidence threshold from 0.5 to 0.3 (was originally 0.25 before previous commits)

---

## Summary by Area

| Area | What changed |
|------|-------------|
| **Frontend** | Complete landing page redesign with constellation bg, chat demo, privacy page, NVIDIA badge |
| **Backend API** | Global CORS, public stats/search/skills/validate routes, removed DELETE skills |
| **Capture** | Headed mode for auth sites, pre-nav response hooking, broader body capture, longer settle |
| **Reverse-engineer** | GraphQL dedup fix, JSON prefix stripping, batchexecute support |
| **Discovery** | KV fallback search when vector search fails, new namespace |
| **Client** | Hardcoded prod API URL, auth flag on write-only calls |
| **Orchestrator** | Confidence threshold tuning (0.25 → 0.5 → 0.3) |
