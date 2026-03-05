# Changelog

## [1.0.0] — 2025-01-01

## fix: bundle-inferred endpoints now capture query param names from JS source

The bundle scanner regex patterns matched query strings (e.g. `/api/search?q=`) but
discarded them in a non-capturing group. Bundle-inferred endpoints had no `query`
field and no `{param}` template vars, forcing users to guess parameter names.

Now the scanner captures query string portions as regex group 2, extracts param
names, and merges them across multiple occurrences of the same path. The endpoint
creation code builds templatized `url_template` (e.g. `/api/search?q={q}`) and
populates `endpoint.query` for bundle-inferred endpoints, matching the behavior
of network-captured endpoints.

## feat: staging environment — isolated namespaces for safe migration testing

Vector namespaces, KV namespaces, and search caches are now derived from
`env.ENVIRONMENT`. Staging uses completely isolated data stores (`unbrowse-staging--`
vectors, `staging-skills` / `staging-stats` KV) so migrations and schema changes
can be tested without touching production data.

- **`backend/src/services/discovery.ts`**: `NS_PREFIX`, `domainNamespace()`, `globalNs()`
  now take `env` and return staging-prefixed namespaces when `ENVIRONMENT=staging`
- **`backend/src/services/kv.ts`**: `skillsKV()` and `statsKV()` return staging-prefixed
  KV namespaces when `ENVIRONMENT=staging`
- **`backend/wrangler.toml`**: Added `[env.staging]` with `ENVIRONMENT=staging`.
  Deploy with `wrangler deploy --env staging`, set secrets with `--env staging`

## refactor: domain-convergent skills — one skill per domain with endpoint-level search

Skills were being created per-intent per-domain, fragmenting the API surface and
limiting search to whatever intent string happened to be captured first. "get bookmarks
from x.com" and "get feed from x.com" produced two separate skills with separate
vector embeddings, making cross-intent discovery impossible.

Now each domain converges to a single skill. Captures accumulate endpoints via
`mergeEndpoints()` instead of replacing them. Search operates at the endpoint
level — each endpoint's description gets its own vector embedding, so "get
notifications" finds the notifications endpoint even if the domain was first
captured for "get events."

- **Backend `publishSkill()`**: dedup changed from `intent-idx:{domain}:{hash(intent)}`
  to `domain-idx:{domain}`. `mergeEndpoints()` (previously dead code) is now wired in
  to accumulate endpoints across captures
- **Per-endpoint vector indexing**: `indexEndpoints()` replaces `indexSkill()` —
  embeds each endpoint's description as `"{description} [{method} {path}]"` with
  batch Nebius API calls. Search results now include `endpoint_id` in metadata
- **Orchestrator**: extracts `endpoint_id` from search results and executes directly,
  skipping BM25 `rankEndpoints()` when vector search already found the right endpoint.
  Removed `hasTriggerMatch` filter on local cache (too restrictive for consolidated skills)
- **Capture**: `executeBrowserCapture()` merges new endpoints into existing domain skill
  instead of replacing. Skill `name` and `intent_signature` set to domain name
- **Migration**: lazy — old `intent-idx:*` entries are scanned as fallback. Old
  skill-level vectors are cleaned up on next `ops/reindex`. New `POST /v1/ops/consolidate`
  endpoint merges all skills for a domain on demand

## fix: cross-domain redirect sites (lu.ma → luma.com) and skill cache persistence

Sites that redirect to a different domain (e.g. lu.ma → luma.com) had three
compounding issues preventing API discovery and execution:

- **Domain affinity filter in extractEndpoints** now uses both the page URL and
  final URL domains. Previously, XHR calls to `api2.luma.com` were filtered out
  because the base domain was `lu.ma` (different registrable domain).
- **Server-side fetch with cookies** — the `serverFetch` path in the skill
  directory now includes auth cookies via the Cookie header and detects API
  subdomains (`api2.*`, `api.*`), routing them to server-fetch instead of
  browser-based execution.
- **Skill cache persistence** — `getSkill()` no longer overwrites a freshly
  published local skill with a stale backend copy (eventual consistency).
  `publishSkill()` pre-caches locally and only merges backend identity fields.
- **Persistent browser profiles for capture** — `captureSession` now uses
  headless persistent profiles (from prior `interactiveLogin`) to preserve
  localStorage/sessionStorage auth. Previously always ephemeral.
- **Client Hints header override** — prevents Chromium 145+ from leaking
  `sec-ch-ua: "HeadlessChrome"` during capture, which triggered bot detection.

## feat: auto-update — skill silently updates itself in the background

End users no longer need to run `npx skills update` manually. On every CLI
invocation the skill checks if it's time for an update (every 4 hours). If so,
a detached background worker fetches the latest commit from GitHub, downloads
the tarball, and copies new files over the skill directory. Dev installs
(symlinks) are automatically skipped.

- **`src/auto-update.ts`**: Orchestrator — reads `~/.unbrowse/config.json` for
  `last_update_check`, spawns worker as detached process, never blocks CLI
- **`src/auto-update-worker.ts`**: Standalone worker — checks GitHub API for
  latest SHA, downloads + extracts tarball, runs `bun install`, stores SHA
- **`src/cli.ts`**: Calls `maybeAutoUpdate()` at the top of `main()`

## feat: extraction hints — agents get structured data on first try

Large API responses (>2KB) were causing agents to flail through 5-7 execute calls
guessing `--path` values. Now the engine analyzes the `response_schema` at inference
time and returns `extraction_hints` with the exact `--path`, `--extract`, and ready-to-paste
`cli_args`. The CLI auto-wraps large responses with hints instead of dumping raw JSON.

- **`src/transform/schema-hints.ts`**: New module — walks `ResponseSchema` to find best data
  array, ranks fields by name semantics (identity > content > metrics > tracking), produces
  `ExtractionHint` with `path`, `fields`, `cli_args`, and `schema_tree`
- **`src/execution/index.ts`**: Attaches `extraction_hints` to all execute responses alongside
  `response_schema` — computed from schema at inference time, zero extra network calls
- **`src/orchestrator/index.ts`**: Passes `response_schema` and `extraction_hints` through all
  execution paths (auto-exec, race, cache hit, post-capture)
- **`src/cli.ts`**: Auto-wraps large responses with hints (replaces 300+ line JSON dumps with
  compact hint output). New `--schema` flag returns only schema + hints without data.
- **`SKILL.md`**: Updated workflow — agents read `extraction_hints.cli_args` and paste directly
  into next execute call. Rule 3 now explicitly forbids guessing paths by trial-and-error.

## feat: JS bundle scanning for API route discovery

During capture, Unbrowse now scans same-domain JavaScript bundles for API route
patterns that were never triggered by network traffic. Previously, endpoints like
`/api/emails/search` on jmail.world were invisible because the capture only
observed passive page-load requests — the search API required typing in a search
box to trigger. Now these routes are discovered via regex scanning of JS bundles.

- **`src/capture/index.ts`**: Collects same-domain JS bundle content during capture (2MB/bundle cap, 20 bundles max)
- **`src/reverse-engineer/bundle-scanner.ts`**: New module — scans bundles for `/api/...`, `fetch("/...")`, and `/v1/...` patterns with deny-list filtering
- **`src/execution/index.ts`**: Merges bundle-discovered routes as low-confidence (`reliability_score: 0.2`) inferred endpoints, deduped against network-observed endpoints
- Zero perf cost: bundles are already downloaded by the browser, no extra requests
- Handles query strings in string literals (e.g., `"/api/search?q="` → `/api/search`)

## refactor: remove extraction recipes, surface response schema

Extraction recipes were brittle hardcoded field mappings that broke when APIs changed
their response shape. Replaced with a schema-first approach: the `response_schema`
(already inferred during capture) is now returned in execute responses so agents can
craft their own `--path`/`--extract` dynamically.

- **Deleted** `src/transform/recipe.ts` and `src/transform/suggest.ts` (~660 lines)
- **Removed** recipe CRUD routes (`POST`/`DELETE /v1/skills/:id/endpoints/:eid/recipe`)
- **Removed** `cmdRecipe` CLI command and `suggested_extraction` auto-apply logic
- **Added** `response_schema` to execute responses — agents see the full inferred schema
- **Added** `schema_summary` in resolve deferral — top-level property names + types replace the old `has_schema` boolean
- **Kept** `--path`/`--extract`/`--limit`/`--raw` projection system unchanged

## feat: URN reference resolution for normalized APIs

APIs like LinkedIn Voyager and Facebook Graph return normalized data in `included[]`
arrays where objects reference each other via `*`-prefixed URN fields (e.g.
`*socialDetail` → SocialDetail → `*totalSocialActivityCounts` → counts). The
extraction pipeline now transparently follows these multi-hop references.

- **`buildEntityIndex()`** / **`detectEntityIndex()`**: auto-detect `entityUrn`-keyed arrays and build a lookup map
- **`resolvePath()` upgrade**: when a field lookup fails, checks for `*field` URN reference and resolves through the entity index
- **Works everywhere**: CLI `--extract` and server-side projection all follow URN references
- **Zero config**: entity index is detected and built automatically; no new flags needed
- **Backward compatible**: non-normalized APIs are unaffected — the `*` resolution only activates when `entityUrn`-keyed arrays are present

## feat: CLI SDK — shell-safe wrapper, no more curl + jq

Agents no longer need curl + jq to interact with unbrowse. The CLI handles all
JSON construction and parsing in TypeScript, eliminating shell escaping issues
(e.g. `!=` being escaped to `\!=` in zsh, breaking jq filters).

- **`unbrowse resolve`**: intent resolution with `--url`, `--endpoint-id`, `--force-capture`
- **`unbrowse execute`**: skill execution with `--skill`, `--endpoint`, `--params`
- **`unbrowse feedback`**: mandatory post-call feedback
- **`unbrowse recipe`**: submit extraction recipes via flags instead of JSON blobs
- **`--extract`**: ad-hoc field extraction from result (e.g. `--extract "user,text,likes"`)
- **`--pretty`**: indented JSON output on any command
- **`--raw`**: bypass extraction recipes for unprocessed data
- **Auto-start**: server spawns automatically if not running
- **bin entry**: `"bin": { "unbrowse": "src/cli.ts" }` in unbrowse-skill package

## feat: extraction recipes — persist parsing knowledge on endpoints

When an agent figures out how to parse a complex API response (e.g. LinkedIn's 500KB
Voyager blob), that knowledge now persists as an extraction recipe on the endpoint.
Future executions auto-return clean, structured output — for all users via the marketplace.

- **ExtractionRecipe type**: filter + field-mapping rules stored on EndpointDescriptor
- **Auto-apply**: recipes applied during execution when no explicit projection is given
- **API**: POST/DELETE `/v1/skills/:id/endpoints/:eid/recipe` to submit/remove recipes
- **Marketplace**: recipes travel with the skill — all agents benefit
- **Escape hatch**: `"projection": {"raw": true}` bypasses recipe for raw data
- **Graceful fallback**: if recipe can't apply (source path missing), returns raw data

## fix: speed, coverage, and accuracy overhaul (bird-style parity)

### Speed: 20s→2s (trigger-intercept), 120s→100ms (server-fetch)
- **trigger-intercept: domcontentloaded not networkidle**: The page.goto was waiting
  for ALL network activity to settle (networkidle). SPAs like LinkedIn never fully
  idle. Now uses domcontentloaded — the intercept promise resolves as soon as the
  specific API call fires, typically 1-3s after navigation starts.
- **Local disk cache before marketplace search**: Marketplace API takes 40-80s
  (search + getSkill). Now checks disk cache first — if a skill exists locally for
  the domain, execute it immediately. Eliminates remote API latency entirely.
- **Cookie quote stripping**: Chrome SQLite stores some values with embedded quotes
  (e.g. JSESSIONID="ajax:..."). RFC 6265 requires unquoted values in Cookie headers.
  LinkedIn's CSRF check was failing because the quoted cookie didn't match the
  unquoted csrf-token header.
- **Accept header preservation**: server-fetch was overwriting endpoint's accept header
  with "application/json". LinkedIn requires "application/vnd.linkedin.normalized+json+2.1".
  Now only sets accept as default when the endpoint doesn't have one.
- **Stored auth headers in vault**: During capture, extract all sensitive headers
  (authorization, x-csrf-token, api-keys) that reverse-engineer strips from skill
  manifests. Store them encrypted in the vault. Server-fetch now works without
  launching a browser — direct HTTP with full auth headers.
- **Route cache on live-capture**: Route cache was only set on marketplace success.
  Now also caches after live-capture so the 2nd identical request skips search.
- **Domain cache TTL 60s→5min**: Prevents re-capture when marketplace hasn't indexed yet.
- **Domain strategy cache**: Once we learn x.com needs trigger-intercept (or server),
  apply that as default for all new endpoints on that domain.
- **Preserve exec_strategy on backend refresh**: `getSkill()` async-refresh from
  backend was overwriting locally-learned exec_strategy. Now merges them.
- **Parallel marketplace race**: Top 3 marketplace candidates execute via Promise.any
  instead of serial loop.

### Coverage: SPA intent-aware API wait
- **Phase 4 in waitForContentReady**: After networkidle, extract a route hint from
  the capture URL (e.g., "bookmark" from /i/bookmarks) and wait up to 5s for a
  matching API response. Catches SPA lazy-loaded APIs like Twitter's Bookmarks
  GraphQL query that fire after initial page load.
- **Synthesized requests**: Response bodies captured by the listener but missed by
  request tracking are now synthesized as RawRequests so they reach extractEndpoints.

### Accuracy: Better endpoint ranking
- **CamelCase tokenization**: GraphQL operation names like `BookmarkFoldersSlice` are
  now split into `["Bookmark", "Folders", "Slice"]` for BM25 matching. Previously the
  entire name was one token, never matching intent words.
- **Stemmer fix**: Added `-ed` and `-ing` suffix stripping. "bookmarked" now stems to
  "bookmark", matching `BookmarkFoldersSlice`. "trending" stems to "trend".
- **Bookmark synonyms**: Added bookmark ↔ saved/favorite synonym expansion.
- **trigger_url tokenization**: Endpoint trigger_url path segments are now included
  in BM25 document tokens.
- **Context URL match bonus**: +20 score when endpoint trigger_url matches the user's
  context URL path.
- **Session plumbing filter**: Filter account/settings, badge_count, DataSaverMode,
  live_pipeline, and other session plumbing from ranking candidates.
- **extractAuthHeaders()**: New export from reverse-engineer that extracts the inverse
  of sanitizeHeaders — all headers that would be stripped from the skill manifest.

### Stale skill prevention
- **Reuse existing skill_id**: Re-captures find the existing cached skill for
  the same domain and reuse its skill_id. Preserves learned exec_strategy across
  re-captures and server restarts.
- **Carry forward exec_strategy**: Learned strategies from old endpoints transfer
  to matching new endpoints by URL template on re-capture.

### Execution strategy fixes
- **Removed domain strategy cache**: One 400 on LinkedIn was locking ALL endpoints
  into trigger-intercept. Strategy is now per-endpoint only.
- **Always try server-fetch first** for new endpoints before falling back.
- **Marketplace race timeout 15s→30s**: Trigger-intercept takes 20s on authed sites.

### Bug fix: Remove persistent profile from captureSession
- captureSession no longer tries to launch headed Playwright with a persistent
  profile directory. Eliminates SingletonLock crashes. Always uses ephemeral
  headless browsers with bird-style cookie injection.

## fix: endpoint ranking + auto-execute after capture

After capturing a site, unbrowse would return "Discovered N endpoints, pick one"
instead of executing the best match. Three root causes fixed:

### `src/reverse-engineer/index.ts` — smarter endpoint collapsing
`collapseEndpoints` was too aggressive — it merged distinct API actions
(e.g. `/relationships/connectionsSummary` + `/invitationsSummary`) into
`/relationships/{relationship}`. Added `looksLikeEntityId()` guard that only
allows collapsing when leaf segments look like entity IDs (UUIDs, numbers,
tickers), not camelCase action names or REST resource words.

### `src/execution/index.ts` — expanded BM25 synonyms + camelCase tokenization + stemmer fix
- Added synonym groups for social/content domains: feed, post, comment, message,
  notification, connection, profile, recommend, news, dashboard.
- `endpointToTokens` now splits long query param values on camelCase boundaries,
  so `voyagerFeedDashMainFeed` tokenizes as `[voyager, Feed, Dash, Main, Feed]`.
- Fixed stemmer: `messages` now stems to `message` (not `messag`), enabling
  synonym expansion for words ending in -ses, -ges, -ces, -zes.

### `src/orchestrator/index.ts` — auto-execute on confident ranking
Instead of always deferring, the orchestrator now auto-executes when:
- Top endpoint scores >= 30 (strong BM25 match)
- Top endpoint has a response_schema (confirmed JSON data)
- Score gap >= 5 over runner-up (clear winner)

### `src/capture/index.ts` — queryId-aware trigger-and-intercept
For graphql endpoints, the intercept now matches on the queryId name prefix
(e.g. `voyagerFeedDashMainFeed`) instead of just the base path (`/graphql`),
preventing it from intercepting the wrong graphql response.

## fix: auth reliability overhaul (bird-style cookie resolution)

Auth was unreliable due to multiple bugs: bidirectional domain matching, expired
cookies never filtered, stale vault cookies never refreshed from browser, missing
CSRF header replay, and inconsistent vault key naming.

Inspired by [bird](https://github.com/jawond/bird) which reads cookies fresh
from browser SQLite every time for zero-staleness auth.

### `src/domain.ts` — fix bidirectional domain matching
`isDomainMatch` had `c.endsWith("." + t)` which allowed `notgoogle.com` to match
`google.com`. Removed — now only matches when target equals or is a subdomain of
cookie domain.

### `src/auth/index.ts` — bird-style cookie resolution
- **`getAuthCookies(domain)`**: new unified resolver with fallback chain:
  vault cookies (fast) → auto-extract from Chrome/Firefox SQLite (fresh).
  No more manual `/v1/auth/steal` calls needed.
- **`filterExpired()`**: cookies with past `expires` are now filtered out on
  retrieval. Session cookies (expires <= 0) are kept.
- **`refreshAuthFromBrowser(domain)`**: on 401/403, auto-extracts fresh cookies
  from browser instead of just deleting stale ones.
- Vault keys normalized to registrable domain (`auth:example.com` not
  `auth:api.example.com`) with backward-compat fallback.

### `src/execution/index.ts` — CSRF replay + auto-refresh
- CSRF token auto-detection: scans cookies for `ct0`, `csrf_token`, `_csrf`,
  `XSRF-TOKEN`, `csrftoken` and sends as `x-csrf-token` header automatically.
- On 401/403: tries `refreshAuthFromBrowser()` before deleting credentials.
  Next retry will use fresh cookies.
- `executeBrowserCapture` and `executeEndpoint` now use `getAuthCookies()`
  (bird-style auto-extract) instead of manual vault lookups.

### `src/auth/browser-cookies.ts` — subdomain cookie extraction
`buildDomainWhereClause` only matched exact domain variants (`.linkedin.com`)
but missed subdomain-scoped cookies (`.www.linkedin.com` where `li_at` lives).
Added LIKE clause to match all subdomains, fixing LinkedIn/similar sites.

### `src/capture/index.ts` — trigger-and-intercept execution
New `triggerAndIntercept()` function: navigate to the page that originally
triggered an API call, let the site's own JS make the request (passing CSRF,
TLS fingerprinting, session validation), and intercept the response. This is
the generalized bird pattern — instead of replaying API calls ourselves, we
let the site's code handle auth and just capture the result.

Also: cookie injection logging, CSRF auto-detection in browser execution.

### `src/execution/index.ts` — 3-tier authed execution fallback
1. Server fetch (bird pattern — fast, works for Twitter/simple APIs)
2. Trigger-and-intercept (navigate page, intercept API call — works for LinkedIn)
3. Browser in-page fetch (last resort)

### `src/reverse-engineer/index.ts` — record trigger_url
Each endpoint now stores `trigger_url` — the page URL that triggered the API
call during capture. Used by trigger-and-intercept execution.

### `src/types/skill.ts` — trigger_url field
Added `trigger_url` to `EndpointDescriptor`.

## fix: skill not found after intent/resolve (cache-first publish)

After `POST /v1/intent/resolve` discovers endpoints, the returned `skill_id` was
immediately unusable — `GET /v1/skills/{id}` returned 404 because the local disk
cache was only written after a successful remote publish to `beta-api.unbrowse.ai`,
and EmergentDB's eventual consistency meant the backend hadn't indexed it yet.

### `src/marketplace/index.ts` — cache-first publish
`publishSkill()` now writes to `~/.unbrowse/skill-cache/` **before** calling the
remote backend. If the remote publish fails, the skill is still locally available
and the function returns the pre-cached version instead of throwing.

### `src/api/routes.ts` — add local `GET /v1/skills/:skill_id` route
Previously this fell through to the catch-all proxy which forwarded to the remote
backend. Now there's a dedicated local route that checks the disk cache first via
`getSkill()`, so recently published skills resolve immediately.

### `src/orchestrator/index.ts` — log publish errors
Fire-and-forget `.catch(() => {})` calls now log the error message instead of
silently swallowing failures.

## fix: stale skill auto-recovery + playwright auto-install

### `src/index.ts` + `scripts/setup.sh` — auto-install browser engine
`agent-browser` depends on `playwright-core` for browser automation, but browser binaries
are NOT bundled — users had to manually run `npx agent-browser install` after
`bun install`, which was undocumented and broke first-run experience.

Fix: the server now checks for Chromium on startup via `playwright-core`'s `executablePath()`
and auto-runs `npx agent-browser install` if missing. `setup.sh` also runs the install step
after dependency installation. Both fall back gracefully with a warning if the install fails.

### `src/api/routes.ts` — auto-recovery on stale 404
When executing a marketplace skill via `POST /v1/skills/:id/execute`, if the remote endpoint
returns HTTP 404 (stale/changed API), the handler now automatically falls through to
`resolveAndExecute()` to re-capture the site and get fresh endpoints. The response includes
a `_recovery` field explaining what happened.

Previously, agents received the raw 404 from the remote API with no context or recovery path.

### `src/execution/index.ts` — improved 404 error messages
When an endpoint returns 404, the error message now explains that the endpoint may be stale
and suggests re-running via `/v1/intent/resolve` to get fresh endpoints. Previously, the error
was just `"HTTP 404"` with the raw remote response body forwarded verbatim.

### `SKILL.md` — browser setup documentation
Added playwright chromium install step to the server startup section so users know the
browser engine needs to be installed on first run.

## fix: sec-ch-ua headless leak + token savings baseline

### `src/capture/index.ts` — sec-ch-ua override
Chromium 145+ auto-sets `sec-ch-ua: "HeadlessChrome";v="145"` independently of the spoofed `user-agent` string. LinkedIn, Google, and Cloudflare all read this header to detect headless browsers, causing them to return reduced/blocked responses.

Fix: always call `browser.setExtraHeaders()` with the correct Client Hints headers for Chrome 131 before navigation, regardless of whether `authHeaders` are provided. Auth headers are merged on top so they still take precedence.

```
sec-ch-ua: "Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
```

### `src/orchestrator/index.ts` — token savings baseline
`discovery_cost.capture_tokens` was being stamped with `ceil(deferralMessage.length / 4) ≈ 18 tokens` (the size of the tiny agent-first deferral JSON) instead of `DEFAULT_CAPTURE_TOKENS = 30_000`. This caused every subsequent marketplace cache hit to compute `tokens_saved = max(0, 18 - responseTokens) = 0`, making `total_tokens_saved` and `avg_tokens_saved_pct` always 0 in the platform stats.

Fix: always use `DEFAULT_CAPTURE_TOKENS` as the `capture_tokens` baseline, which correctly represents the LLM-browsing cost a downstream agent would incur doing this manually.


## fix: graceful browser shutdown + orphan cleanup (fixes #4)

### `src/capture/index.ts`
- **Browser registry**: `activeBrowserRegistry: Set<BrowserManager>` tracks every live browser instance. Registered on creation, removed in `releaseBrowserSlot()`.
- **`shutdownAllBrowsers()`** exported — calls `browser.close()` on all active instances in parallel via `Promise.allSettled`. Used by shutdown handlers in `src/index.ts`.
- **Per-capture hard timeout** (`CAPTURE_TIMEOUT_MS = 90_000`): each `captureSession()` race includes a 90-second wall-clock kill. If triggered, `browser.close()` is called before throwing a timeout error, freeing the slot and the process.
- `releaseBrowserSlot(browser?)` now accepts the browser instance and removes it from the registry on release.
- `executeInBrowser()` updated with the same registry pattern.

### `src/index.ts`
- **Startup orphan cleanup**: `pkill -f chrome-headless-shell` runs before `app.listen()` to kill leftover browser processes from previous crashed sessions.
- **`SIGTERM` / `SIGINT` handlers**: call `shutdownAllBrowsers()` then `app.close()` before exiting — ensures in-flight captures close cleanly on Ctrl-C or container stop.


## URN path segment parameterization

### `normalizeUrl()` now detects URN identifiers (`src/reverse-engineer/index.ts`)
- **URN pattern**: Path segments like `urn:li:fsd_profile:ACoAAB3fei4B...` are now replaced with `/{urn}` during URL normalization, just like UUIDs and numeric IDs.
- **`templatizePathSegments()`** handles the new `{urn}` placeholder — captures the original URN as a default value and renames the param based on the preceding path segment.
- Fixes skills for LinkedIn (and other URN-based APIs) hardcoding specific profile/entity URNs instead of parameterizing them.

## Real discovery cost tracking + token savings in traces

### Discovery cost on skills (`src/types/skill.ts`, `backend/src/types.ts`)
- **`DiscoveryCost` interface**: New optional `discovery_cost` field on `SkillManifest` records `capture_ms`, `capture_tokens`, `response_bytes`, and `captured_at` from the original live capture.
- **Stamped during live capture** (`src/orchestrator/index.ts`): After a browser capture discovers a skill, the actual capture time and token cost are measured and attached to the skill before publishing. Future marketplace cache hits use these real baselines instead of hardcoded estimates (22s / 30K tokens).

### Token fields in ExecutionTrace (`src/types/skill.ts`, `backend/src/types.ts`)
- **`tokens_used`**: Estimated tokens consumed by the response.
- **`tokens_saved`**: Tokens saved vs original capture cost (0 for live captures).
- **`tokens_saved_pct`**: Percentage tokens saved vs original capture cost.
- These fields are stamped by the orchestrator and persist in trace files (`traces/*.json`) and backend reporting.

### Real baselines in finalize (`src/orchestrator/index.ts`)
- **`finalize()` reads `skill.discovery_cost`** when computing token/time savings. Falls back to the old hardcoded estimates (30K tokens, 22s) only for legacy skills without `discovery_cost`.
- **Console log indicates baseline source**: `[real baseline]` vs `[estimated]` so you can tell at a glance which skills have been re-measured.

## Agent-first endpoint selection + ad schema filtering

### Always defer to agent on fresh captures (`src/orchestrator/index.ts`)
- **Removed BM25 ambiguity heuristic**: The old logic auto-executed when the top endpoint had a score lead, which often picked wrong (ad endpoints, tracking, config blobs). Now fresh captures always return the endpoint list and let the calling LLM agent choose.
- **Agent-specified endpoint_id still auto-executes**: When the agent has already picked an endpoint, it executes directly without deferral.

### Schema-based ad endpoint filtering (`src/reverse-engineer/index.ts`)
- **`looksLikeAdResponse()`**: Detects ad/tracking endpoints by response body vocabulary (campaignId, creativeId, creativeContent, etc.) regardless of hostname. Prevents junk skills from being published.
- **`facet-futures.` added to AD_HOSTS**: Blocks the betting/odds ad network that Dotabuff uses.

### Always surface available_endpoints (`src/api/routes.ts`)
- **Removed `length > 1` gate**: `available_endpoints` is now returned even when only 1 endpoint exists, so the agent always sees what was discovered.

## LLM-driven endpoint selection — expose endpoints to the agent

### Endpoint labeling (`src/execution/index.ts`)
- **`deriveEndpointLabel()` generates human-readable labels**: Extracts meaningful names from endpoint URLs. GraphQL queryIds like `voyagerFeedDashMainFeed.abc123` become "Feed Main Feed". REST paths like `/voyager/api/relationships/dash/connections` become "Relationships: Connections". Labels are derived by splitting camelCase, dropping common prefixes (voyager, dash, com), and capitalizing meaningful words.
- **Exported for use by routes**: Both `rankEndpoints` and `deriveEndpointLabel` are exported so the API layer can build rich endpoint metadata.

### Enriched `available_endpoints` in API responses (`src/api/routes.ts`)
- **Labels added**: Each endpoint in `available_endpoints` now includes a `label` field with the human-readable name.
- **Response hints**: When an endpoint has a response schema, `response_hint` lists the top-level property keys (e.g. `["data", "included"]`).
- **Limit increased from 5 to 15**: Complex sites (LinkedIn, Facebook) can have 40+ endpoints — surfacing only 5 was insufficient for the agent to find the right one.
- **Execute route also surfaces endpoints**: `POST /v1/skills/:id/execute` now includes `available_endpoints` so the agent can pick a different endpoint without going back to intent/resolve.

### Ambiguous score deferral (`src/orchestrator/index.ts`)
- **BM25 ambiguity detection**: When a newly captured skill has 5+ endpoints and the top two scores are within 5 points, the orchestrator does NOT auto-execute. Instead it returns the skill + ranked endpoints with a message telling the agent to pick.
- **Clear winner auto-executes**: When the top endpoint has a significant score lead, it auto-executes as before.

## Fix: SPA capture rewrite — direct request/response pair capture

### Capture rewrite (`src/capture/index.ts`)
- **Direct request/response pair capture**: Replaced the broken two-source approach with a single `page.on("response")` handler that captures the full request+response pair. Now captures 40+ endpoints from LinkedIn vs 3 before.
- **Network idle detection replaces fixed 5s wait**: Polls until no new responses arrive for 2s (max 8s).
- **Scroll simulation triggers lazy-loaded content**: 3 scroll steps with network idle waits between.

### Endpoint collapse fix (`src/reverse-engineer/index.ts`)
- **GraphQL endpoints exempt from collapse**: Endpoints with `queryId` or `query` params, or paths containing `graphql`, are never collapsed.
- **API sub-resource endpoints exempt from collapse**: Paths matching `/api/` with 3+ segments are kept separate.
- **Vendor JSON types scored correctly**: `scoreRequest()` now awards the +4 content-type bonus for `+json` types.

### Orchestrator quality gate (`src/orchestrator/index.ts`)
- **HTML-postprocessed results rejected**: When a marketplace skill returns HTML that gets DOM-extracted, the orchestrator rejects it and falls through to the next candidate or live capture.

### DOM skill publishing gate (`src/execution/index.ts`)
- **Low-confidence DOM skills not published**: DOM-extracted skills below 0.4 confidence are no longer published.
- **CamelCase tokenization in BM25 endpoint selection**: `endpointToTokens()` now splits camelCase identifiers.

## BUG-006: Path segments now parameterized instead of hardcoded

### Bug fix
- **Dynamic path segments are now templatized**: When a live capture discovers API endpoints like `/api/v3/quote/SPY,QQQ`, the reverse-engineer now detects dynamic segments and replaces them with named template variables (e.g. `{quote}`), storing the original values as defaults in `endpoint.path_params`. Previously, these values were hardcoded, making skills unusable for different inputs (e.g. requesting TSLA data would always return SPY/QQQ).
- **Two detection strategies**: (1) Comma-separated path segments are always parameterized — a strong signal for lists of identifiers. (2) Context-aware matching — path segments that appear in the captured page URL are detected as entities and parameterized (e.g. capturing `/en/coins/bitcoin` parameterizes `bitcoin` in API paths like `/price_charts/bitcoin/usd/24_hours.json`).
- **Execution merges path_params as defaults**: `executeEndpoint()` now merges `endpoint.path_params` into the params object before URL interpolation. User-provided params override defaults, so `{quote: "TSLA"}` replaces the captured `SPY,QQQ`.
- **Improved dedup**: `normalizeUrl()` now collapses comma-separated path segments for deduplication, preventing multiple endpoints from being created for the same API path with different identifier lists.

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
