# Changelog

## [2.12.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.12.0...v2.12.1) (2026-04-03)

### Features

* detect install-specific upgrade and repair commands during setup so global npm installs get the right guidance
* smoke-test the packaged global CLI in CI and tag releases before publish

### Bug Fixes

* **ci/deploy**: let `staging` pushes run the repo sanity/unit/backend/CLI gates, deploy the backend to the Wrangler `staging` environment, and only deploy the `frontend-staging` worker when `PREVIEW_API_URL` is configured so integration testing does not accidentally point at the wrong backend
* harden the npm wrapper so stale fallback installs fail with a precise reinstall command instead of silent runtime crashes
* return the installed version from `unbrowse --version`
* repair packaged wrapper execute bits during postinstall and fail fast on stale local-server version mismatches


## [2.12.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.11.0...v2.12.0) (2026-04-03)

### Bug Fixes

* auto-queue browse submit publish and document public repo ([9905005](https://github.com/unbrowse-ai/unbrowse-dev/commit/9905005afa86402ac75d521381e6ca2eec1ab184))
* preserve backend kv binding during CI release deploys ([#282](https://github.com/unbrowse-ai/unbrowse-dev/issues/282)) ([47e0c72](https://github.com/unbrowse-ai/unbrowse-dev/commit/47e0c7223a24f68e84f8ebec4b4892acb635f217))
* restore skills.sh discovery gate ([#285](https://github.com/unbrowse-ai/unbrowse-dev/issues/285)) ([e5299f4](https://github.com/unbrowse-ai/unbrowse-dev/commit/e5299f480ec2b19ca85981f6706d0edf155aaed2))
* ship standalone repo setup and main-base docs ([#281](https://github.com/unbrowse-ai/unbrowse-dev/issues/281)) ([2c66398](https://github.com/unbrowse-ai/unbrowse-dev/commit/2c663989fd7b31aa3a87b5fed29b71c22c088f8e))
* simplify install setup path ([#294](https://github.com/unbrowse-ai/unbrowse-dev/issues/294)) ([98d97d3](https://github.com/unbrowse-ai/unbrowse-dev/commit/98d97d30beaa737511f02926e5c43f3f648600b5))
* simplify install setup path ([#295](https://github.com/unbrowse-ai/unbrowse-dev/issues/295)) ([a4c7fa9](https://github.com/unbrowse-ai/unbrowse-dev/commit/a4c7fa94d90a412042eda4184fd66c83705aa676))

## Unreleased

### Features

- add tracked agent memory guidance and require agents to keep durable Lewis preferences in the repo instructions
* add a real `unbrowse mcp` stdio server with `initialize`, `tools/list`, `tools/call`, and core Unbrowse resolve/execute/browse tools
* add a deterministic `./setup --host mcp` bootstrap that writes a ready MCP config file, plus a frontend MCP install option and downloadable `/mcp.json` template
* **setup/upgrade**: add `unbrowse upgrade`, persist install metadata so clone installs get the right upgrade command, and register GSD-style session-start update hints for Codex and Claude during setup
* **backend/github**: add a real GitHub webhook receiver for opt-in PR maintenance, with `X-Hub-Signature-256` verification, branch update/auto-merge actions, conflict comments, and 6-hour Telegram digests from the backend worker cron
* **backend/github**: add a real GitHub webhook receiver for opt-in PR agent runs, with `X-Hub-Signature-256` verification, workflow dispatch on PR/check-suite events, a self-hosted `pr-agent.yml` Codex repair runner, and 6-hour Telegram digesting for failed dispatches
* add root `glama.json` metadata so Glama can discover and attribute the Unbrowse MCP server to `@lekt9`
* add a root `smithery.yaml` registry manifest so Smithery can classify and install Unbrowse as a stdio MCP server
* **ci/frontend**: add GitHub Actions PR previews for the Cloudflare/OpenNext frontend with stable `pr-<number>` preview aliases, sticky PR comments, and staging-API wiring via `PREVIEW_API_URL`
* **cli/analytics**: surface machine-readable per-run impact (`time_saved`, `tokens_saved`, `browser_avoided`) plus likely next actions in resolve/execute responses, and persist richer session telemetry so the canonical funnel can reason over success and savings instead of only coarse counters
* **routing telemetry**: add a sanitized `POST /v1/telemetry/routing` ingest path, shared routing event types, orchestrator-side session/step/candidate/outcome emission, and a derived `/v1/analytics/routing` summary for future long-running agent router training
* **routing analytics**: enrich `/v1/analytics/routing` with source-level speed/success stats plus top intents/domains so we can see what agents use most and which routing paths are actually fastest
* **frontend/miners**: replace the hardcoded miners bounty board and weekly quests with demand-driven backend data aggregated from recent CLI search/resolve telemetry, so the board now tracks what agents are actually asking for
* **setup/wallets**: encourage Crossmint `lobster.cash` during new-install bootstrap, surface it in setup status/docs, and point walletless installs at `npx @crossmint/lobster-cli setup`
* **growth/landing**: add sticky SSR homepage experiments, landing-token install attribution, variant-level landing funnel analytics, an ops landing-funnel panel, and a daily optimizer workflow that rebalances live weights while only generating shadow variants inside approved messaging slots
* **frontend/funnel**: re-center the homepage on first success after install with a copyable verification + resolve path, and extend acquisition analytics to measure install-copy to first-task-copy conversion

### Tests

* add MCP stdio smoke coverage for initialize, tool listing, and health tool calls
* add routing telemetry sanitizer, idempotent backend ingest, and routing analytics regression coverage
* add a real CLI-to-backend routing telemetry E2E that runs the live orchestrator path, verifies sanitized `routing-event:*` writes, and asserts `/v1/analytics/routing` updates from the emitted session
* add live landing-funnel end-to-end coverage for signed token attribution, CLI telemetry propagation, analytics rollup, and daily optimizer reweighting

### Bug Fixes

* **cli/cache**: add a `cleanup-stale` sweep that re-verifies active skills, evicts stale local cache entries, and now rotates through periodic server-side batches so dead marketplace endpoints stop getting replayed
* **kuri/tests**: stop the Kuri live e2e suite from hijacking a visible Chrome session by honoring headless launch flags and running the fixture-browser tests in headless managed mode
* **github/pr-agent**: split webhook dispatch into `repair` vs `merge` operations, ignore agent-self-failure loops, isolate runner `CODEX_HOME`, and let Codex make the merge recommendation before a final non-vibes safety gate executes the merge
* **ci/tests**: isolate CLI end-to-end runs on a per-suite local-server port and clear backend KV index caches in popularity tests so self-hosted runners stop leaking state across jobs
* **ci/backend-tests**: keep live beta-api backend smoke suites opt-in so required CI stops failing on external network and deployment flakiness
* **ci/package-cli**: run the packaged CLI smoke on a per-run port and pre-accept ToS in non-interactive mode so self-hosted runners stop talking to stale local servers
* **policy/execute**: add per-endpoint third-party-terms policy flags for sensitive domains like X, block autonomous mutation execution until callers pass explicit `confirm_third_party_terms`, and surface the policy requirement through resolve/CLI/MCP/SDK
* **legal/terms**: clarify that users bear responsibility for third-party website and API terms, disclaim liability for third-party ToS violations to the maximum extent permitted by law, expand indemnity coverage for third-party claims, and fix the company name in ToS copy
* **backend/payments**: split discovery from paid manifest access with `X402_SEARCH_ENABLED`, so `/v1/search*` can stay free while paid `/v1/skills/:id` detail remains x402-gated
* **docs/whitepaper**: sync the companion docs with the shipped x402 and Crossmint wallet flow so payment gates, wallet-linked payout routing, and current settlement behavior stop reading as “coming soon”
* **docs/mcp**: make the public README surfaces explicitly describe Unbrowse as a stdio MCP server, document `initialize` / `tools/list` / `tools/call`, enumerate the shipped MCP tool groups, and clarify that `localhost:6969` is the runtime behind the MCP surface rather than a custom host protocol
* **browse/registry**: auto-flush and queue background publish after successful `unbrowse submit` steps, return explicit next-step hints for browser-submit flows, and document `unbrowse-ai/unbrowse` as the canonical public repo for external registry submissions
* **frontend/homepage**: sharpen homepage positioning around AI agent builders, clarify the browser-automation replacement story, and reduce copy clutter across the hero, install, and registry sections
* **frontend/copy**: normalize the public role name to `contributor` across leaderboard and economics pages while keeping mining as the campaign verb
* **frontend/registry**: stop stale search-index hits from linking to dead registry skill detail pages, and label them as index-only until the live registry has a backing skill page
* **frontend/registry**: swap the homepage registry showcase from recent linked cards to list-only popular skills backed by observed execution counts
* fix packaged MCP autostart by removing a duplicate `recordAnalyticsSession` export that broke the packaged local-server bootstrap path behind the installer-generated MCP command
* **frontend/install**: simplify the landing-page install path around one clear command, reduce CTA clutter, trim install tabs, and make the copy action grab the primary command instead of the full block
* **cli/tests**: stop local server bootstrap from blocking `/health` on remote auto-registration, make API routes wait briefly for background registration instead of failing fast, isolate snapshot-heavy e2e fixtures from the user’s real `~/.unbrowse` cache, and skip wallet bootstrap in the packaged setup smoke
* **wallet/setup**: detect paired lobster.cash agents from local `~/.lobster/agents.json` state so `setup --no-start` and payout sync reuse an existing local wallet instead of re-entering interactive wallet setup
* **analytics**: stop labeling cached execute paths as manual browser usage, and derive canonical funnel activation/aha/repeat from successful session telemetry
* **cli/install**: bake global-install diagnostics into the npm wrapper, add a real `unbrowse --version`, repair wrapper/launcher execute bits during postinstall, and fail loudly when a stale local server on `:6969` is serving a different package version than the installed CLI
* **linkedin/replay**: keep unrelated infrastructure path prefixes like LinkedIn `litms` literal during capture, and bypass robots gating for authenticated session-backed execution so captured private feed endpoints can replay through the user session
* preserve the production backend KV binding during CI deploys so release runs stop re-requesting KV write scope
* clean checked-in merge markers, restore the curl install script, and add a repo blog-publish helper so the stale frontend-history branch can be absorbed without dragging its generated junk forward
* **backend/storage**: make Neon-backed worker KV writes transactional, clear poisoned init-cache entries after transient Neon bootstrap failures, and add regression coverage for both paths
* split `main` deploys from tag releases so ordinary `main` pushes stop surfacing a no-op npm publish path when the current CLI version is already on npm
* simplify the homepage install story around `curl -fsSL https://unbrowse.ai/install.sh | bash`, add `npx skills add unbrowse-ai/unbrowse` as the skills-host shortcut, and demote repo-clone setup to fallback copy
* **cli/browser-capture**: preserve top-level resolve errors in slim CLI output, return structured browser-capture failures instead of raw 500s, and isolate CLI E2E runs onto their own local server so live auth paths stop binding to stale ambient state
* **cli/auth**: surface blocked auth-gated captures as structured auth prompts instead of opaque empty resolve output, stabilize the X CLI auth smoke on a real search URL, and restore clean backend typecheck on the miner-demand board

## [2.11.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.10.2...v2.11.0) (2026-04-02)

### Features

* **#100:** implement robots.txt directive checking before route execution ([d920e7e](https://github.com/unbrowse-ai/unbrowse-dev/commit/d920e7e87058a3ea645e24b0f4441b44d8442867)), closes [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100) [#100](https://github.com/unbrowse-ai/unbrowse-dev/issues/100)

### Bug Fixes

* harden browse submit recovery ([652f03b](https://github.com/unbrowse-ai/unbrowse-dev/commit/652f03b8146744fbfac4f0e70faee3798754db71))
* harden main release workflow reruns ([f80cd5d](https://github.com/unbrowse-ai/unbrowse-dev/commit/f80cd5d3a5ada81fa285ca59e302c26aa47bb02d))
* publish runtime deps in npm package ([9659770](https://github.com/unbrowse-ai/unbrowse-dev/commit/96597707c161a2de9f1424bbb622e0be203e7fbf))
* seed canonical replay after x402 detail search ([6524063](https://github.com/unbrowse-ai/unbrowse-dev/commit/6524063b3ee9f77f7fb8a1e187291bb7ec72066b))

## [2.10.2](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.10.1...v2.10.2) (2026-04-02)

### Bug Fixes

* unblock worker deployment ([ef8a5ba](https://github.com/unbrowse-ai/unbrowse-dev/commit/ef8a5badb2868c20fde988ebb98b123201e8da36))

## [2.10.1](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.10.0...v2.10.1) (2026-04-02)

### Bug Fixes

* unblock self-hosted releases ([5dd2139](https://github.com/unbrowse-ai/unbrowse-dev/commit/5dd2139f49068cb2eb24a15489833b7a4c187638))

## [2.10.0](https://github.com/unbrowse-ai/unbrowse-dev/compare/v2.9.1...v2.10.0) (2026-04-02)

### Features

* publish openclaw npm install flow ([ab1257f](https://github.com/unbrowse-ai/unbrowse-dev/commit/ab1257f1ff2c180d7bb07a390a7270555ffe896e))
* publish openclaw npm install flow ([#260](https://github.com/unbrowse-ai/unbrowse-dev/issues/260)) ([2e6a252](https://github.com/unbrowse-ai/unbrowse-dev/commit/2e6a2520393a5f2bf9e0ed5e9a5e1c34b14973a8))
* restore canonical analytics surface ([#262](https://github.com/unbrowse-ai/unbrowse-dev/issues/262)) ([78f83c8](https://github.com/unbrowse-ai/unbrowse-dev/commit/78f83c827b3d9292da16b5eaebf98cc6b63b8b2d))
* ship wallet-first dashboard on restart-base ([#265](https://github.com/unbrowse-ai/unbrowse-dev/issues/265)) ([a673969](https://github.com/unbrowse-ai/unbrowse-dev/commit/a67396913f90b87acf705e60b9042c94cfe34610))
* track analytics sessions by trace version ([5954238](https://github.com/unbrowse-ai/unbrowse-dev/commit/595423886b426a3032fb683e83b4e4bd102d3931))

### Bug Fixes

* ship worker payments and lobster x402 e2e ([#263](https://github.com/unbrowse-ai/unbrowse-dev/issues/263)) ([d3ec78f](https://github.com/unbrowse-ai/unbrowse-dev/commit/d3ec78fa049378bb9066f55f707ed608dc560daf))
* unblock openclaw install PR ([422096b](https://github.com/unbrowse-ai/unbrowse-dev/commit/422096b734ebd926a136286a221be2c4a0be71c2))

## [Unreleased]

### Bug Fixes

* telemetry/dashboard: derive per-run baseline vs actual speed/cost from real or fallback orchestrator economics, surface those totals on contributor dashboards, and cover the math with savings sims plus dashboard contract tests

### Features

* **sdk**: add a first-party `@unbrowse/sdk` TypeScript client for the canonical local server routes, with typed `resolve`/`execute`/auth helpers, SDK tests, and first-party API/quickstart docs instead of forcing app developers through raw fetch or CLI wrappers
* **analytics**: restore the canonical investor analytics surface (`growth`, `usage`, `funnel`, `network`, `economics`, `dashboard`), add explicit `POST /v1/analytics/sessions` runtime ingestion, split the legacy setup funnel onto `/v1/analytics/install-funnel`, make the canonical funnel monotonic with recovered profiles excluded and surfaced separately, and unbreak manual execute auth warmup so end-to-end session ingestion actually reaches the analytics backend
* **backend/storage**: add Neon-backed canonical state storage for the Worker via a Postgres-backed KV adapter, ship a Cloudflare-KV-to-Neon backfill script, and wire `DATABASE_URL` as the production worker secret so agent profiles, skills, ledgers, and analytics state can cut over from EmergentDB/legacy KV drift to Neon
* **frontend/economics**: switch the web dashboard to wallet-first public lookup on `rach/restart-base`, with public `/dashboard` wallet search, public `/dashboard/:wallet` contributor ledgers, wallet-linked leaderboard rows, and backend wallet lookup routing
* **frontend/blog**: canonicalize legacy article slugs back to their static routes, dedupe those slugs from the `/blog` feed and sitemap, and add FAQ schema/content for the proof-of-indexing economics page
* **orchestrator/economics**: centralize timing economics math, persist baseline vs actual time/cost totals through telemetry, and surface browser-baseline plus speedup metrics in the public contributor dashboard
* **cli/auth**: retry `resolve` through browser-cookie import before forcing interactive login, detect blocked interactive login states more explicitly, and auto-fall back from paid marketplace search to free exact-URL live capture when indexing fallback is available
* **resolve**: enrich `available_endpoints` with depth-limited `schema_summary` (3-level recursive tree), `input_params` (key/type/required/example), `description_in`, and `example_fields` — agents can now pick endpoints and build extraction paths from the resolve response alone without needing separate schema calls
* **cli**: implement `--path`, `--extract`, `--limit`, `--schema` post-processing in `execute` — flags were documented but never wired; now support nested array drilling (`data.items[].nested[].field`), field aliasing (`alias:deep.path`), null-row filtering, and item limiting
* **cli**: auto-wrap large responses (>2KB) with `extraction_hints` including schema tree and byte count when no extraction flags are given

### Bug Fixes

* **packaging/release**: pin Kuri submodule validation to `justrach/kuri#adding-extensions`, build and upload `dist/unbrowse-*` GitHub release assets in CI/CD, smoke-test the compiled single-binary packaging path, and select the embedded Kuri payload by runtime target instead of hardcoding `darwin-arm64`
* **skills/install**: quote all `SKILL.md` descriptions as valid YAML block scalars so `npx skills add unbrowse-ai/unbrowse` discovers the published Unbrowse skill again instead of bailing out with "No valid skills found", and add a dedicated CI/release gate that runs `tests/skill-docs-sync.test.ts` before packaging/publish
* **github/docs**: update PR helpers and validation docs to treat `main` as the canonical base branch after the branch rename, so release/merge instructions stop pointing at the dead `rach/restart-base` branch
* **analytics/security**: stop advertising authenticated analytics responses as publicly cacheable, add `Vary: Authorization`, remove user-facing analytics docs links, and pin the private header contract in end-to-end coverage
* **install**: add a deterministic repo-native `./setup` bootstrap, switch the npm wrapper fallback to the stable Node launcher, and keep the standalone CLI package manifest pinned to the runtime payment deps (`bs58`, `@solana/kit`, `@cascade-fyi/splits-sdk`) so the public install path no longer depends on a healthy GitHub release asset plus a lucky npm fallback
* **payments/wallets**: treat the configured wallet address as the single contributor/payment truth across setup, agent wallet sync, 402 error payloads, and transaction proof wiring, including generic agent-wallet providers instead of hardcoding lobster-only labels
* **skills**: add a repo-local `internal-analytics` skill with a deterministic fetch helper so agents can pull private analytics without treating the surface as public docs
## fix: mirror Claude skills into Codex installs

- `scripts/sync-skill.sh` now routes local skill linking through a shared helper so the active Claude/Codex `unbrowse` links resolve to the current monorepo checkout instead of drifting to stale worktrees or copied skill dirs.
- New `scripts/sync-skill-links.ts` also mirrors Claude skill directories into `~/.codex/skills` without overwriting Codex-specific entries, so the same global skill set is available in both hosts.

* **cli**: add `unbrowse review` command — agents can push reviewed descriptions, action/resource kinds, and examples back to endpoint metadata via `POST /v1/skills/:id/review`
* **cli**: add `unbrowse publish` command — two-phase agent-driven publish: Phase 1 returns endpoints with `schema_summary`, `sample_values`, `input_params` and `_fill_description` placeholder; Phase 2 merges agent descriptions, updates local caches, and publishes to marketplace
* **skill/worktree**: add a repo-local worktree capability loop plus `issue:worktree:*` / `capability:worktree:*` helpers so an agent can fix GitHub issues or capability asks, mine public URLs from those asks into temporary eval cases, rerun the repo's regression loop, and always run a Codex cold/warm regression suite for phase 0 browse plus phase 1 replay
* **skill/worktree**: add a read-first Codex harness doc for the worktree capability loop so the primary contract is instructions the agent performs manually, with helper scripts kept as optional convenience only
* **skill/worktree**: make the worktree harness subagent-first for product proof, so real case judgment and cold/warm benchmark evidence outrank Vitest-style repo tests when deciding whether a capability actually works
* **eval**: add `/unbrowse-eval` skill and `eval:agent` script — agent-driven end-to-end site testing (browse → index → resolve → execute → verify) with growing case set
* **frontend/economics**: add explicit `/login`, `/dashboard`, and `/leaderboard` surfaces for agent-key auth, economics visibility, and public contribution ranking
* add investor-facing analytics coverage: `/v1/analytics/growth`, `/v1/analytics/usage`, `/v1/analytics/network`, `/v1/analytics/economics`, plus session/adoption/pricing ingestion so cohort retention, new-user growth, skill reuse, external adoption, and path-to-$100k math are API-trackable
### Bug Fixes

* **openclaw/plugin**: resolve the bundled Unbrowse CLI from the installed package `bin` entry instead of guessing `bin/unbrowse.js`, bump the plugin dependency to `unbrowse@^2.10.2`, and add execution-path regression coverage so the OpenClaw plugin can actually launch the packaged runtime again
* **openclaw/plugin**: add tarball-level packaging coverage for `unbrowse-openclaw` so published npm releases keep the installer `bin/` + `scripts/` entrypoints and the README `npx unbrowse-openclaw install --restart` flow stays real
* **openclaw/plugin**: switch the installer off `openclaw plugins install` and onto a managed extension-dir write plus `plugins.load.paths` rewrite, so current OpenClaw builds stop blocking the plugin's legitimate `child_process` usage during npm/npx installs
* **ci/release**: fix main-branch release metadata parsing so npm package name/version resolve correctly in GitHub Actions, fail fast if those outputs are empty, and treat duplicate-version npm publishes as idempotent no-ops instead of blocking deploy + skill sync
* **tests/graph-api**: bound live graph API requests with explicit fetch timeouts, remove the extra retry fallthrough, and make fixture publishing best-effort so the backend integration suite stops timing out in `beforeAll` during CI reruns
* **tests/search-live**: treat fast `429 Rate limit exceeded` replies as acceptable bounded outcomes in the live search perf/composite smoke tests, so shared CI load no longer fails the backend suite when beta search is responsive but throttled
* **telemetry/funnel**: wire the landing-page acquisition tracker into the homepage, track install-command copy events, and emit real CLI install/funnel telemetry (`cli-first-seen`, `cli_invoked`, `setup_completed`, `registration_succeeded`, `resolve_started`, `resolve_completed`) from the canonical setup/resolve/execute paths so install and activation analytics stop reading as zero
* **docs/frontend**: ground quickstart/API/deployment docs against the current repo and point public docs links at `docs.unbrowse.ai`
* **ci/backend**: force Wrangler v3 backend deploys with KV bindings onto the legacy worker upload path so canonical release jobs stop failing on Cloudflare `/versions` permission checks
* **frontend/openclaw**: clarify the public OpenClaw install flow around `npx unbrowse-openclaw install --restart`, note that the plugin package pulls in the local Unbrowse runtime automatically, and call out the one-time trust prompt older OpenClaw builds may show
* **github/default-branch**: rename `rach/restart-base` to `main`, make `main` the repo default branch, and retarget PR/release docs plus helper scripts
* **frontend/blog**: keep legacy article slugs canonical by redirecting `/blog/<slug>` to the live static article route, dedupe legacy-vs-dynamic blog listings, and emit legacy article URLs into `sitemap.xml` so published pages are actually discoverable by crawlers
* **auth/replay**: persist LinkedIn replay-critical headers (`accept`, `csrf-token`, `x-li-*`, `x-restli-protocol-version`) alongside sensitive auth headers, infer `csrf-token` refresh from `JSESSIONID`, and drop blank publish-sanitized header values at execute time so sanitized skills still replay authenticated Voyager requests correctly
* **ci/regressions**: add GitHub issue regression coverage for #69/#70/#71 plus Codex eval-contract tests to the default test path and CI unit job so HAR ownership/header regressions stop slipping past automation
* **eval/flags**: fix Codex harness boolean flag parsing so `--benchmark`, `--force-capture`, `--restart-server`, and `--require-dag` actually take effect instead of silently no-oping
* **browse/session**: validate stored Kuri tabs before reuse, recreate the browse session once on recoverable CDP/transport failures or empty snapshots, and fall forward to a fresh Kuri port when the default listener is wedged, so `unbrowse go/snap/eval` no longer stay pinned to dead tabs or a poisoned `127.0.0.1:7700`
* **browse/submit**: add `POST /v1/browse/submit` plus `unbrowse submit`, with generic DOM submit first, same-origin HTML rehydrate fallback, best-effort `data-load-plugins` / `WRS.require` recovery, and capture restart so JS-heavy multi-step checkouts can advance without site-specific JS indexing
* **github/ci**: remove stale `main` base-branch assumptions from workflows and PR helper scripts so repo automation targets `rach/restart-base` only
* **ci/backend**: restore the shared telemetry type exports used by analytics routes, make the x402 gate Worker-safe without Node `Buffer`, mark the live graph-edge test truly opt-in again, and stop npm `prepack` from deleting tracked Kuri binaries before CI package validation
* **docs/skill sync**: restore the full public `docs/whitepaper/` set from git history, make `scripts/sync-skill.sh` copy the monorepo `docs/` directory into the public skill repo so long-form docs stop disappearing on downstream syncs, and keep public entrypoints free of internal-only framing
* **docs/messaging**: align the public README and skill entrypoints around the buyer-facing category line "drop-in browser for agents" while keeping the explanation grounded in route learning, reuse, and browser fallback
* **docs/messaging**: sharpen the public category line to a drop-in replacement for OpenClaw / `agent-browser` browser flows, with explicit ~30x faster / ~90% cheaper framing for the API-native path and stronger "browser work becomes a reusable asset" language
* **review**: fix skill lookup in review route to check domain cache (same as GET route) — previously returned 404 for skills only in domain snapshots
* **review**: fix review route to update all local caches (domain snapshot + domain cache + published skill cache) so reviewed metadata is visible on next resolve without requiring marketplace round-trip
* **execute**: return `endpoint_not_found` error with available endpoints list when agent-specified endpoint_id doesn't exist in skill — previously silently fell through to `selectBestEndpoint` and executed the wrong endpoint
* **execute**: apply agent's params to trigger URL during trigger-and-intercept execution — previously replayed the original captured URL ignoring new search terms, causing search endpoints to return stale/unfiltered results
* **skill sync**: restore standalone skill repo docs during `scripts/sync-skill.sh` by copying the monorepo `docs/` tree after the package rsync, so quickstart/API/release docs stop disappearing on the next sync
* **resolve**: skip the first-pass browser fast-path for canonical replay pages like npm/PyPI package search and package detail URLs, so deterministic structured fetches run before flaky browser handoff
* **payments/search**: make production cloud search routes return x402 `402 PAYMENT-REQUIRED` terms for Tier 3 graph lookups, and propagate those payment-required errors through the runtime instead of silently downgrading to empty marketplace results
* **resolve/canonical replay**: when paid marketplace search blocks a canonical detail page like PyPI package records, seed a local structured replay skill instead of dead-ending at `payment_required`, so agents still get a runnable endpoint for free deterministic detail fetches
* **payments/tests**: add backend route coverage for the x402 skill gate so paid skill reads now prove the real `402` header handshake and proof-accepted retry path
* **payments**: align the backend x402 gate with lobster.cash and Corbits by emitting `PAYMENT-REQUIRED` v2 terms, settling `PAYMENT-SIGNATURE` retries through the facilitator, and preserving the older `X-Payment-Proof` fallback for legacy clients
* **payments/splits**: sync creator payout wallets onto agent profiles, route single-contributor paid skills directly to that wallet, add an authenticated wallet-sync endpoint for existing agents, fan transaction ledgers out across contributor payouts from skill attribution shares, and teach publish-time split provisioning to accept either a fixed Cascade `split_config` override or auto-create/update one through `@cascade-fyi/splits-sdk`
* **payments/auth**: enforce auth on protected skill/stats write routes again, carry the current wallet through publish to avoid wallet-sync/read-after-write races, and clear stale single-wallet `split_config` values when a skill becomes multi-contributor
* **payments/policy**: disable Cascade-based multi-contributor routing for now and send paid skill proceeds to the current majority contributor wallet only, with creator ledgers following the same single-recipient policy
* **payments/e2e**: verify real Lobster x402 settlement against staging end-to-end, document `X402_NETWORK_MODE=mainnet` for staging workers, and note that winning contributor wallets must already have a mainnet USDC token account for Corbits settlement to succeed
* **payments/flags**: add Worker-level `PAYMENTS_ENABLED` kill switch so x402 gates and Tier 3 search fees can be disabled entirely without changing skill pricing metadata or redeploying code paths
* **packaging**: publish the runtime payment deps (`bs58`, `@solana/kit`, `@cascade-fyi/splits-sdk`) in the npm CLI package so global installs no longer crash before `unbrowse help` / `unbrowse health`
* **cli/auth**: improve agent UX on gated sites by auto-falling back from paid marketplace search to free `--force-capture`, trying browser cookie import before interactive login, and refusing to treat Cloudflare challenge pages as successful login
* **telemetry/economics**: add per-agent savings ledgers from `POST /v1/stats/perf`, expose `GET /v1/dashboard/me` and `GET /v1/leaderboard`, and propagate billed Tier 3 search cost through the client/runtime for dashboard truth
* **auth**: cookie injection via raw CDP for full `secure`/`httpOnly`/`sameSite`/`expires` support — Kuri's `/cookies` endpoint was dropping these flags, causing HTTP 400 on LinkedIn and other sites requiring secure cookies
* **auth**: strip wrapping quotes from cookie values — Chrome stores JSESSIONID as `"ajax:..."` with literal quotes that broke LinkedIn's CSRF validation
* **publish**: re-cache skill locally after marketplace publish to prevent `publishSkill`'s backend merge from overwriting agent-updated descriptions

### Features
* **#218**: wire DAG planner to backend EmergentDB graph — dag-advisor now queries the backend graph (fetchChain) first for cross-session intelligence with local planner fallback; publishEdgesToBackend fixed to use correct URL (beta-api.unbrowse.ai) and send Authorization headers; planner.ts stub replaced with real delegation to dag-feedback
* **#155**: add BM25 lexical channel with RRF fusion — `indexEndpoints` stores docs in KV; `searchIntentInDomain` runs BM25 + graph in parallel and fuses with RRF (k=60), falling back to graph-only when no index exists
* **#221**: wire `computeCompositeSearchScore` into search/resolve path — search results are now rescored with the Section 3.3 composite formula (40% embedding, 30% reliability, 15% freshness, 15% verification) instead of pure vector similarity; orchestrator scoring aligned to use continuous verified ratio
* **#220**: wire `computeBottleneckMetrics` into backend — new `GET /v1/analytics/bottleneck` route returns latency percentiles (p50/p95 for capture, resolve, execute), cache/marketplace/live-capture hit rates, failure rate, and skills-per-domain capacity metric, all loaded from KV perf stats and skill data

### Bug Fixes

* **publish-pipeline**: `wrong_entity_type` verdict downgraded from `fail` to `skip` — captures with non-standard field names (e.g. `body` instead of `text`, `entityUrn` instead of `id`) no longer block marketplace publishing; post classifier expanded to accept real-world API field names (`message`, `_id`, `entityUrn`, `from.name`, `created_time`, etc.)
* **tests**: rewrote stale release-flow, CLI, and payments coverage so reruns match the current product contract; unit runs no longer depend on repo version drift or live pricing/backend state, CLI JSON stdout stays machine-safe, and slow integration suites use hermetic/sequential setup instead of host-coupled timeouts
* **tests**: removed mock-only incomplete backend spec fossils and promoted the local CLI payload contract suite into always-on coverage, so the remaining incomplete tests are opt-in live/integration paths instead of stub-server TODOs
* **kuri/tests**: fixed live-browser tab registration and text snapshots in the Kuri client, replaced placeholder wrapper/action TODOs with real end-to-end browser coverage, promoted the P0/P1 and graph-edge live suites into always-on tests, and moved marketplace latency diagnostics out of the `*.test.ts` suite
* **#223**: wire `isStructuredSearchForm`, `attributeLifecycle`, and `isRepeatableEval` into production code — search forms are detected from captured HTML and attached to endpoints, lifecycle phases are attributed for observability in the orchestrator and publish flows, and eval repeatability checking flags flaky cases in the harness
* **#229**: implement `tryFirstPassBrowserAction` — navigates to the URL, records HAR, performs intent-driven actions (search/click/navigate), collects intercepted JSON API responses, and synthesizes a mini-skill for passive indexing ([#229](https://github.com/justrach/unbrowse34/issues/229))
* **capture**: thread AbortSignal through CDP phases so 90s timeout aborts hanging kuri calls immediately instead of waiting for each call's own 30s timeout to stack ([#113](https://github.com/justrach/unbrowse34/issues/113))
* **#152**: `mergeEndpoints` now promotes richer endpoint rediscoveries instead of silently dropping them
* **#152**: `mergeEndpoints` now promotes richer endpoint rediscoveries instead of silently dropping them
## [2.0.1](https://github.com/justrach/unbrowse34/compare/v2.0.0...v2.0.1) (2026-03-15)

### Features

* migrate backend to EmergentDB Graph API ([#85](https://github.com/justrach/unbrowse34/issues/85)) ([fabfe87](https://github.com/justrach/unbrowse34/commit/fabfe87ce21d4b66cfc918ea383a90ff772e6f32))
* sharpen landing hero value prop ([56b6035](https://github.com/justrach/unbrowse34/commit/56b60356a24984e1f785ae3dc2f160979576b6ee))

### Bug Fixes

* bundle kuri runtime in cli releases ([4353f3e](https://github.com/justrach/unbrowse34/commit/4353f3ecb574aa9c8dc67855318d29624d3d87d3))
* stabilize frontend deploy fonts ([a51c4e2](https://github.com/justrach/unbrowse34/commit/a51c4e29a75f233c62147a48029ece978b8af281))

## [2.0.0](https://github.com/justrach/unbrowse34/compare/v1.1.5...v2.0.0) (2026-03-14)

### Features

* auto-execute + SSR fast-path (15s → 3.6s) ([318c10f](https://github.com/justrach/unbrowse34/commit/318c10f243543857a945b34488ce0214780094c8))
* auto-execute DOM extraction endpoints with LLM param inference ([b03b0d2](https://github.com/justrach/unbrowse34/commit/b03b0d25e403b86f930f49575b2f182fbfeb0859))
* auto-execute, SSR fast-path, route/domain caching, evals, backend improvements ([0fd9346](https://github.com/justrach/unbrowse34/commit/0fd93468102e62364e1a31697cf8e6ea9e3b1a12))
* domain-level skill cache for cross-intent reuse ([1aa8361](https://github.com/justrach/unbrowse34/commit/1aa8361f671bf91f3f31e1320e3caa9c6df965e1))
* expand public eval corpus and prep v2.0.0 ([b75f8d2](https://github.com/justrach/unbrowse34/commit/b75f8d2f73e49bc9b96e38feadf3c2a0135c88a4))
* persist route cache to disk (survives restarts) ([a6a5eae](https://github.com/justrach/unbrowse34/commit/a6a5eaeac33a264bfe099e07465e02e4f71f26d6))
* replace agent-browser with Kuri — CLI-first Zig-native browser automation ([6053014](https://github.com/justrach/unbrowse34/commit/6053014c7c05411cac5988dd62ec2fa5ff417169)), closes [#71](https://github.com/justrach/unbrowse34/issues/71) [#71](https://github.com/justrach/unbrowse34/issues/71)

### Bug Fixes

* catch 'setPassword is not a function' keytar errors and fall back to encrypted file vault ([71a53af](https://github.com/justrach/unbrowse34/commit/71a53af4ff20e01e570cd7b51e3c2c21a63497e4))
* stale route cache + domain cache persistence ([55bc5a4](https://github.com/justrach/unbrowse34/commit/55bc5a4a272972b20e24446ad3e2c8e5b860c59a))

## 1.1.5 (2026-03-11)

### Bug Fixes

- **resolvePath**: changed URN fallback condition from `val === undefined` to `val == null` so references resolve when normalized APIs set inline fields to explicit `null` (LinkedIn Voyager, Facebook Graph, REST-li)
- **detectEntityIndex**: replaced hardcoded `obj.included` / `obj.data.included` lookups with generic scan of all top-level and one-level-nested arrays, picking the largest `entityUrn`-keyed array

## 1.2.0 (2026-03-13)

### Auto-Execute — Intent-Driven Parameterization

Skills with URL template parameters (e.g. `?k={k}`) now auto-execute by filling params from the user's intent instead of deferring with "pick an endpoint." This eliminates the manual execute step for search-style queries across any website.

- **`buildDeferralWithAutoExec()`** — every deferral path now attempts auto-execution first. Single entry point, catches all code paths.
- **`inferParamsFromIntent()`** — LLM-based (gpt-4.1-mini) param inference maps natural language intent to URL template params. Generalizes to any site: Amazon's `k`, Yelp's `find_desc`/`find_loc`, Booking's `ss`, etc.
- **Fast-path for single params** — simple search intents (e.g. "find wireless headphones") extract terms directly without LLM, saving ~2s per request.
- **DOM extraction endpoints trusted** — skip LLM judge for `dom_extraction` endpoints since cheerio-extracted data uses heading-based schemas that confuse the judge.

### SSR Fast-Path — HTTP Fetch Instead of Browser

Server-side rendered sites (Amazon, etc.) no longer launch a browser for cached skills. Plain HTTP fetch + cheerio extraction replaces Playwright navigation.

- **`tryHttpFetch()`** — plain `fetch()` with realistic browser headers and cookie injection, 10s timeout, fails fast on non-200/non-HTML/small responses (<1KB).
- **Silent browser fallback** — if HTTP fetch fails (bot detection, JS-rendered content), falls back to full browser capture automatically.
- **Result**: cached SSR queries dropped from **15s → 3.6s** (4x faster). No browser launched, no GPU/memory overhead.

### Skill Promotion

- Auto-executed skills from live-capture are now promoted to marketplace cache via `promoteLearnedSkill()`, so subsequent requests hit the fast marketplace path instead of re-capturing.

---

## Unreleased

### Packaging

- Added the upstream `justrach/kuri` repo as a tracked git submodule and restored `.gitmodules` metadata for the existing OpenClaw plugin submodule, so repo checkouts can initialize both dependencies cleanly.
- The npm CLI package now bundles platform-specific Kuri binaries during `prepack`, resolves them before falling back to repo-local builds, and `unbrowse setup` now verifies or builds Kuri instead of trying to install stale `agent-browser` / Playwright assets.
- Skill repo sync now carries a vendored Kuri source snapshot into the standalone publish repo so package rebuilds do not depend on a sibling `~/kuri` clone.

### Evals

- Added an autonomous Codex eval harness that runs auth-aware resolve/execute loops, checks DAG reachability, escalates through force-capture plus deeper `trigger_url` retries, and stops with explicit `pass`/`fail`/`skip`/`blocked` outcomes instead of a manual-only shortlist.
- Expanded eval case schema/product-truth judging with auth persona metadata plus `entity_type`, `min_rows`, `side_effect`, `echo_params`, and `terminal_ok` validation so site coverage can assert discovery, DAG selection, and real execution outcomes in one artifact.
- Added autonomous benchmark mode for explicit cold-vs-warm comparisons, surfacing per-round source/latency/token telemetry plus per-case speedup and token deltas between first capture and second reuse runs.
- Added a dedicated auth eval runner plus a popularity-backed auth corpus. It bootstraps vault auth via browser-cookie reuse or scripted demo logins, then runs each case through the autonomous harness with a top-level auth artifact and per-site child artifacts.
- Workflow auth evals now score latency budgets against warm-path timings while still recording raw cold timings, so discovery-first passes stop failing purely because the first capture was expensive.
- Scripted auth bootstrap now supports profile-only success pages that do not persist reusable cookies, and the auth runner hands those cases to the harness without forcing a cookie-based auth skip.
- Autonomous harness now trusts a passing direct resolve payload before it burns time on replay candidates, which prevents learned endpoint detours from regressing already-correct DOM captures during suite runs.
- Autonomous public evals now follow `learned_skill_id` placeholders into the real learned skill, synthesize endpoint shortlists from that manifest, and accept common URL aliases like `link` / `mdn_url` / `html_url` when the product-truth case expects `url`, fixing npm/MDN/Stack Overflow bulk-site regressions.
- Added a shard/resume Codex campaign runner for large eval sweeps. It slices case corpora into resumable shard files, runs the autonomous harness sequentially per shard, and writes merged campaign artifacts so larger runs can scale toward hundreds or thousands of cases without one giant fragile foreground process.
- Added a generated bulk-seed corpus and builder script that merge the shipped public/product/auth suites into one deduped campaign file for larger-site smoke sweeps.

### Reverse Engineering

- Reverse-engineered mutation endpoints now templatize replayable request-body inputs into `body` placeholders plus `body_params` defaults, infer cookie-backed CSRF plans from captured traffic, and feed request-body semantics into endpoint admission so authenticated action flows are more likely to replay cleanly instead of being stored as one-off captured payloads.
- DOM extraction now promotes single-record detail pages and auth success/flash messages into stable `title`/`message`/`flash` records instead of low-confidence multi-candidate blobs, improving durable replay for logged-in demo flows like Practice Test Automation and The Internet.

### Authentication

- Added custom Chromium-family cookie import for `/v1/auth/steal`, including explicit browser selection plus optional user-data dir, cookie DB path, and macOS Safe Storage service overrides so Electron-style app sessions can be reused without re-login when their cookie store is local.
- Broken `keytar` native-binding shims from the Bun-built npm bundle now demote cleanly to the encrypted file vault at runtime, so `resolve`/auth reads no longer crash under Node 25 when the optional native module is present but unusable.
- Missing local `kuri` binaries now fail with a normal startup warning instead of crashing the CLI/runtime during bootstrap.
- CLI startup now validates the active API key against `/v1/agents/me`, ignores stale env/config keys that no longer have agent profiles, and re-registers instead of silently dropping agent activity/execution telemetry.
- Backend auth now recreates missing `agent:*` profiles on first valid key use, so orphaned keys stop disappearing from lifecycle/activity analytics.
- Local `wrangler dev` registration now falls back to the built-in `local-test` admin key when Unkey secrets are stubbed, so backend smoke tests can bootstrap without live Unkey credentials.
- Fixed EmergentDB KV `listWithValues()` so prefixes with more than 30 trimmed/overflowed entries no longer silently undercount after the first backfill batch.

### Setup & onboarding

- Added a publish guard around `packages/skill` so direct folder-level npm publishes now fail closed with instructions to use the repo-root release flow, plus explicit root scripts for `bun run pack:cli` and `bun run publish:cli` when a synced local publish is intentional.
- Release config now sets `npm.ignoreVersion=true` so `release-it` does not re-run `npm version` after `@release-it/bumper` has already synced the root package, skill package, and `version.json`.
- Added a skill README callout asking users to post sites/APIs they could not get working in GitHub Discussion #53 so those failures can become explicit requirements in the next eval cycle.
- Added `unbrowse setup` as the one-command bootstrap for npm/npx installs. It checks prerequisites, installs browser assets, registers Open Code's `/unbrowse` command, and can skip server start with `--no-start`.
- `unbrowse setup` now asks for an email-style agent identity up front and `UNBROWSE_AGENT_EMAIL` can preseed the same display identity in headless setups, while opaque backend agent ids stay unchanged.
- Added the repository's Star History chart to the synced skill README so marketplace installs keep the same social proof/docs surface as the main repo.
- Switched public onboarding to the npm-backed `unbrowse` CLI, with `npx unbrowse` for zero-install trials and `npm install -g unbrowse` for repeat use.
- Removed runtime skill self-update. npm/npx is now the code update path, while `SKILL.md` stays repo-managed and is checked during pack/release flows.
- Docs now explicitly tell existing users to rerun `npm install -g unbrowse`, `unbrowse setup`, and host-side skill update commands after releases so local installs do not stay stale.
- Every CLI command now auto-starts the local server using package-relative bootstrap paths, pid tracking, and local log files.
- Shrunk the npm tarball to the runnable CLI/runtime only, dropping skill metadata and other non-runtime publish clutter while keeping the local server boot path intact.
- Browser installation now runs through the bundled `agent-browser` dependency instead of shelling out through `npx`, making fresh installs more reliable.
- Added skill-level installer metadata plus a standalone OpenClaw plugin for hosts that want a native Unbrowse-first integration.
- Release CI now validates the npm tarball on every main/PR build, publishes `packages/skill` to npm on release tags, and refuses canonical releases when npm or skill-sync secrets are missing.

### Agent behavior & demo UX

- Tightened the skill and Open Code command prompts so agents stay on Unbrowse instead of drifting into Brave Search, ad hoc `curl`, or other fallback web tools unless the user explicitly allows it.
- Cut the pre-commit hook down to fast staged-file checks only; the old server boot plus eval sweep now lives behind `bun run precommit:full` instead of blocking every commit.
- Added CLI progress notices during slow first-time capture/indexing so demos read as "working" instead of "hung."
- Preserve structured LinkedIn feed results in the CLI instead of wrapping them with stale raw extraction hints from the pre-projection payload.
- Added `bun run release:announce` to turn release notes or the unreleased changelog into a short announcement summary and X-ready post draft.
- Release hooks now also write `.release-announcement.md` and `.release-announcement.json` during `bun run release`.
- Added generator/resolve debug traces in `traces/` for testing mode so capture admission, ranking, and auto-exec failures are easier to inspect.

### Retrieval accuracy & reliability

- Added generic single-record detail-page DOM extraction plus broader `*desc*` class handling, so product/detail/profile-style pages can be judged as structured key-value records instead of falling through as empty captures.
- Resolver marketplace hydration now rejects mismatched page-artifact-only skills for concrete detail URLs, and endpoint ranking more aggressively demotes wrong page artifacts when the requested detail page is a different path on the same domain.
- Prefer same-trigger structured timeline/search APIs over captured page artifacts for post-search intents, so X search resolves to `SearchTimeline`-style endpoints before page-shell artifacts.
- Added more public structured replay rewrites for DEV tag pages, pub.dev package pages, RubyGems gem pages, Stack Overflow tag pages, and Jmail search pages, so those routes resolve through stable APIs instead of slow browser capture.
- Added a public document-fetch fast path before browser capture, letting server-rendered public pages seed reusable page-artifact skills without paying browser startup cost when plain HTML extraction already passes intent/quality checks.
- Normalized bracketed/indexed HTML query params like `filters[0][value]` into stable agent bindings (for example `filters_0_value`) across capture, page-artifact templating, DAG bindings, and execution-time param merging.
- Stopped public resolve/execute paths from auto-scraping browser cookies on vault misses; public replayable sites now stay on fast unauthenticated fetch paths, while browser auth refresh remains reserved for explicitly auth-backed endpoints.
- Added canonical public replay rewrites for GitHub repository search and MDN docs search so those task URLs can resolve through fast server fetch instead of falling through to slow browser capture in the product-success eval lane.
- Tightened the generic support gate so bundle-inferred ghost routes no longer count as a successful site capture by themselves, public no-data captures stop defaulting to misleading auth hints, and generic intent judging now rejects weak DOM junk for questions/definitions/posts while recognizing docs/recipes/courses.
- Fixed canonical structured replay learning to keep the public API URL as the learned endpoint instead of collapsing back onto the source page URL, so Hacker News / Hugging Face style public sites stop reusing stale DOM artifacts when a replayable JSON endpoint exists.
- Stopped canonical replay endpoints from inheriting duplicate source-page query params during execution, and ranked replay endpoints above sibling DOM artifacts, so public API-backed searches auto-execute the real JSON route instead of 400ing on extra params or reporting stale page-artifact metadata.
- Canonical structured replay learning now keeps generic query templates for public search pages and materializes blank search roots into replayable API templates, so the agent path can populate `--params` inputs instead of depending on whatever query happened to be in the original page URL.
- Graph planning now treats DOM/HTML form pages as first-class provider nodes by inferring dropdown/filter bindings from extracted option fields, so dependency walks can model page -> selected form value -> downstream API chains instead of assuming every dependency comes from JSON endpoints.
- Normalized Hacker News DOM rows and Jmail public email search rows into judged story/email records so niche public canaries no longer fail just because the page fallback used site-shaped field names.
- Replaced generic reverse-engineered endpoint descriptions with semantic descriptions derived from the actual route/schema, added Discord guild probes for server intents, and demoted referral/promotion/billing/page-shell noise so server/channel intents stop ranking meta endpoints above real guild APIs.
- Hardened Reddit retrieval with canonical `.json` normalization, browser-like replay headers, queue bypass for known structured routes, and `old.reddit.com` fallback candidates.
- Improved concrete entity-detail retrieval so LinkedIn, profile, and company URLs prefer observed APIs over page-shell artifacts, sidebar noise, and stale browser routes.
- Materialize more public eval roots into concrete public pages for GitLab, npm, PyPI, Docker Hub, and Pinterest so auth-free captures start from real search/detail surfaces instead of barren homepages.
- Added canonical public replay rewrites and intent normalization for Mastodon, GitLab, npm, PyPI, and Docker Hub so public package/image/project pages resolve against real JSON APIs and package/tag payloads judge correctly.
- Drop PyPI search and Mastodon timeline/search from the public no-auth eval materialization when the live site now serves a client challenge, auth wall, or empty public post results instead of real public data.
- Eject stale warm-cache and captured-cache entries when endpoint ids 404, degrade semantically, or fail auto-exec, allowing resolve to recover through fresh ranking and capture.
- Drop empty or unreplayable learned skills before publish/reuse and skip empty endpoint drafts centrally so dead capture branches stop polluting the marketplace.
- Ignore bundle-inferred settings/login/webauthn routes during public root captures and stop crashing when a live capture only learns unusable endpoints.
- Preserve `{placeholder}` query templates when merging captured/default query params so context-derived and CLI-provided inputs actually interpolate into GET executions.
- Added regression coverage for captured request-body learning plus CLI `--params` payload ingress on both resolve and execute paths.
- Prefer more specific DOM replay selectors for generic people-card captures, and keep non-API same-page replays from inheriting the new browser-like structured replay headers.
- Retry browser capture once with a fresh ephemeral profile when a persistent profile collapses its page/context, reducing public CLI flake on GitHub-style captures.
- Prefer structured document replay or server fetch when a canonical data URL or observed API exists, instead of getting trapped on stale browser strategies.
- Scope route-cache reuse to the concrete task URL and client id so warm retrieval replays the same good path instead of drifting across tasks or callers.
- Tightened skill-generation gates so only parsed JSON/HTML responses with intent-matching semantics become reusable endpoints.
- Improved route ranking and auto-exec by preferring immediately executable endpoints, inferring templated params from the request URL, and demoting page-shell routes when a real internal API exists.
- Improved GitHub, Mastodon, X, and other high-traffic domains by ranking repo/search/trending endpoints higher when the page context and query params match.
- Replay DOM extraction from a rendered browser page when needed and unwrap extracted payloads before intent projection.
- Restored LinkedIn feed support after the CLI/server wrap by splitting camelCase query ids during semantic admission and ranking, so `voyagerFeedDashMainFeed` beats profile/news noise again; also restored local `unbrowse sessions` output instead of proxying that debug command to the backend.

### Evals, testing, and infra

- Removed the old overlapping eval entrypoints and consolidated interactive agent validation around the Codex harness so local debugging and `precommit:full` have one canonical product-path eval flow.
- Eval harness now shuts down its locally booted server on exit, reducing sticky long-tail runs between repeated stress passes.
- Added a Codex-facing CLI harness for one-off or file-backed cases. It runs the real `resolve`/`execute` path, records local verdicts plus execution evidence, and writes a local artifact for Codex to inspect during interactive debugging.
- Added a canonical public no-auth Codex suite covering popular, replay-friendly targets (GitHub, npm, PyPI, GitLab, Docker Hub) so there is always a stable baseline to run without local browser auth.
- Added param-seeded public cases plus graph/DAG selection and dependency-walk summaries directly into the canonical Codex harness artifact, so the single eval path now covers query population and multi-step pipeline traversal in the same run.
- Added fixture-backed HTML form DAG coverage and deduped repeated dependency edges, so graph artifacts stay readable when the same binding appears in both query and template form.
- Expanded the stable public suite with Reddit and added a broader benchmark-inspired agent-target suite covering popular public sites agents hit in WebVoyager/WebArena-style tasks, plus niche public targets like Hacker News search and Jmail search.
- Expanded the broader agent-target suite again with long-tail public sites agents commonly touch for docs, Q&A, package lookup, and dev communities: Stack Overflow, MDN, DEV, crates.io, RubyGems, pub.dev, and Lobsters.
- Removed the external model ordering/judging path from the Codex harness. It is now collector-only, and the canonical eval flow is agent-in-thread review of the recorded artifact.
- Serialized judge requests and same-domain live captures to reduce timeout noise and self-conflicts in strict real-world benchmarks.
- Made judged evals stricter and closer to the real CLI path: execute deferred endpoints after resolve, retry on HTML/empty/wrong-entity payloads, normalize judge outputs, and score raw CLI payloads directly.
- Preserved `NEBIUS_API_KEY` across runtime preset switches and added file-backed `prod` / isolated `testing` presets to avoid env drift.
- Expanded CLI/e2e and graph-v2 coverage with auth-aware runs, dependency-aware endpoint fixtures, and local harnesses for endpoint selection testing.
- Queue agent telemetry writes so execution and feedback stats stop dropping under concurrent load.
- Fixed release version bumping so the root `package.json` stays in sync with `packages/skill/package.json` and `version.json`.

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

### 11. Local Graph Harness Expanded

- Added local cache case generation so graph-v2 retrieval can be evaluated against real cached skills without the remote server
- Added dependency-walk simulation using example bindings to validate that graph edges unlock the right downstream operation
- Added local timing metrics for selection speed and time-to-correct-operation, plus wrong-selection counts before the right operation

### 12. Remote Truth, Local Debug Only

- Removed disk-snapshot skill reads from the default resolver path so runtime selection no longer prefers stale local cache over shared remote skills
- Changed `getSkill()` to fetch remote first; local disk snapshots now remain explicit harness/debug artifacts instead of runtime truth

### 13. Better Local Semantic Authoring

- Reverse-engineering now writes richer local endpoint descriptions from captured request/response context before publish
- Semantic examples now flatten request inputs and compact response examples so future skills carry clearer action/resource hints and dependency inputs
- Auth-backed captures now mark learned endpoints as `auth_required` so graph retrieval and local evals can keep public/auth-gated coverage separate
- Graph inference now derives stronger `provides` bindings from fields like `full_name`, `public_identifier`, `owner`, `username`, and `slug` so real captured skills form better dependency edges
- Graph selection now uses a hybrid filter path: hard-drop near-certain junk (`telemetry`, `experiments`, `ads`, wrong-status/auth/config endpoints) and soft-penalize ambiguous helper/settings/recommendation endpoints before semantic ranking
- Product-truth CLI coverage now includes explicit public and auth-gated resolve/execute flows, and `AGENTS.md` now requires product-behavior tests to go through the CLI/orchestrator path instead of raw capture primitives
- Local API routes now reopen freshly learned in-memory skills before remote publish/index catch-up, so a deferred CLI `resolve` can immediately follow with `execute` on the same server process
- Added a dedicated CLI judged eval runner that grades actual CLI/orchestrator output with the Nebius judge model across public and auth-gated cases, instead of relying on plumbing heuristics alone
- Root-cause quality gates now reject low-quality DOM fallback output before returning success, learned skills retain the actual capture intent instead of only the domain, extraction hints rank arrays by intent semantics, and CLI auto-extract only fires on high-confidence hints
- Browser-capture execute now falls back to trigger URLs from the learned skill when the caller has no explicit `params.url`, and merged endpoints are normalized to valid manifest verification states before republish
- The judged CLI eval now preserves original `url` and `intent` when it follows a deferred `resolve` with `execute`, so browser-capture and dynamic skills are graded through the real end-user context
- DOM extraction now has stronger GitHub/LinkedIn HTML parsers, and auto-exec now synthesizes safe defaults for common missing query params (`limit`, `page`, `resolve`, some `type` values) instead of deferring immediately
- Runtime is API-first again: HTML from non-DOM endpoints now fails clean instead of being treated as content, internal API candidates get a stronger preference over DOM during auto-exec, and multi-entity API payloads are projected to the intent-matching entity set before return/judging
- GitHub search fallback now reads the embedded JSON result payload directly, and Mastodon-style search endpoints now infer public-safe defaults like `type=statuses` with `resolve=false` for post intents
- Browser capture now learns a replayable page-artifact endpoint alongside discovered APIs when the captured page already contains structured data, so the orchestrator can try API replay first and then fall back to the captured page artifact on the next attempt

---

## Summary by Area

| Area                 | What changed                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Frontend**         | Complete landing page redesign with constellation bg, chat demo, privacy page, NVIDIA badge |
| **Backend API**      | Global CORS, public stats/search/skills/validate routes, removed DELETE skills              |
| **Capture**          | Headed mode for auth sites, pre-nav response hooking, broader body capture, longer settle   |
| **Reverse-engineer** | GraphQL dedup fix, JSON prefix stripping, batchexecute support                              |
| **Discovery**        | KV fallback search when vector search fails, new namespace                                  |
| **Client**           | Hardcoded prod API URL, auth flag on write-only calls                                       |
| **Orchestrator**     | Confidence threshold tuning (0.25 → 0.5 → 0.3)                                              |

- fix: reject auto-exec results unless they semantically satisfy the intent; judge skips no longer count as success
- fix: add generic DOM extraction for social post rows and trending topic rows so page-artifact fallback rescues empty API captures
- fix: CLI judged eval now falls back to local semantic grading when the remote judge returns skip
- fix: make browser capture actively stimulate dynamic search/explore pages after navigation so SPA-only APIs have a chance to fire before skill generation

- fix: normalize nested trend payloads into topic rows so runtime/evals can accept valid trending results
- fix: DOM replay now rejects stale selector hits that no longer match the requested entity type and falls back to fresh page extraction
- feat: add local agent-phase eval harness over the 100-site project dataset with separate index and retrieve phases plus concurrent client support
- fix: agent-phase eval now groups by target id for exact 100-site coverage and auto-restarts the local server if it dies mid-run
- feat: agent-phase eval now uses an LLM judge on returned data, with local semantic fallback when the judge skips or times out
- fix: route-cache reuse now applies to normal resolve calls, and capture-cache reuse is marked as a real cache hit for phase evals

# Unreleased

- fix: materialize under-specified root eval cases into real-world intent URLs before strict judged agent-phase runs
- fix: reuse learned skills by domain plus compatible intent instead of merging unrelated captures into one polluted skill
- fix: strip self-referential page URL params before minting replayable page-artifact endpoints
- fix: thread original context URL and intent through execute so page-artifact skills replay against the real page, not generic domain fallbacks
- fix: rank endpoints with semantic action/resource intent matching so wrong-entity auth-page APIs stop outranking the correct search surface
- fix: queue concurrent live captures per client/domain instead of failing fast when multiple agent requests hit the same site at once
- fix: serialize live captures per domain across clients so shared browser profiles do not corrupt concurrent auth-site captures
- fix: fall through from wrong-entity marketplace candidates to real live capture instead of deferring same-domain junk skills

# Unreleased

- fix: retry browser capture without persistent profile only for sparse blocked-shell captures; keep rich API captures and bound browser close time so x profile/trending resolves no longer hang
- test: add focused graph dependency-inference unit coverage so DAG edge generation is asserted directly, not only through higher-level walk tests
- feat: agent-facing chunk responses now show only runnable operations in a readable format with a suggested next step, while raw graph/dependency data stays internal
- fix: agent-phase eval now kills hung CLI subprocesses, times out stalled phases, and rewrites artifacts after every completed case so benchmark runs stay observable
- fix: agent-phase eval now records which stage timed out (`auth`, `resolve`, `execute`, `judge`) so benchmark failures point to the real bottleneck
- fix: agent-phase eval now kills leaked `src/cli.ts --no-auto-start` clients before and after runs, and force-kills timed-out CLI subprocesses so stale benchmark traffic no longer poisons the local server
- fix: stale eval cleanup now matches both relative and absolute `src/cli.ts` / `evals/agent-phases.ts` process paths, which were the real leaked-process source on local benchmark runs
- fix: stale eval cleanup now excludes the currently running harness process instead of killing its own benchmark run on startup
- fix: orchestrator live-capture queue now has a hard timeout around both in-flight waits and browser-capture execution, so one hung capture cannot poison all later requests for that domain
- fix: normal-mode skill reopen now falls back to recent in-memory skills when remote read-after-write lags, so same-process route-cache retrieve stops recapturing freshly learned domains
- fix: same-process skill lookups now prefer the fresh in-memory learned skill over remote merged copies, preventing retrieve from reopening polluted domain-wide skills during strict evals
- fix: freshly generated live-capture skills are now promoted into broad route/domain reuse only after they actually answer the originating intent, instead of caching bad deferrals for later retrieves
- fix: generation-time semantic admission now understands company/org and stricter post/comment entities, blocking metadata/subreddit-shell captures from becoming reusable skills

# Unreleased

- docs: sync the canonical repo whitepaper to the April 1 arXiv draft and refresh the paper landing page metadata, authors, subtitle, and abstract
- fix: replace placeholder Kuri/capture TODO suites with real live-browser end-to-end coverage and promote deterministic CLI/P0-P1 regression checks into the default test lane
- fix: repair backend live route/test wiring and add bounded rate-limit retries so `bun run test:all` completes green against the current live graph backend
- docs: add canonical `test:e2e:truth` and `test:claims` lanes so user-visible behavior has an explicit live/e2e gate separate from unit coverage
- fix: planner now treats captured query/path/example defaults as satisfiable bindings, so replayable APIs stop losing readiness to page artifacts on warm resolve
- fix: semantic ranking now demotes linkedin sharebox/mailbox ui payloads for people/company intents and boosts real search/detail surfaces
- fix: semantic intent scoring now distrusts mislabeled ui-scaffold endpoints, so generated sharebox/mailbox/notification skills stop stealing people/company search intents
- fix: scoped warm-result cache now reuses recently validated results on the same route/intent, preventing slow recapture on immediate retrieve
- pre-commit now runs DAG/replay regressions plus strict real-world `agent-phases` smoke instead of `evals/perf.ts`.
- fix: codex harness deferred cases now stop at resolve and emit agent-review execute commands instead of auto-running fallback endpoint attempts inside the harness
- fix: orchestrator `resolve` no longer auto-executes based on marketplace/ranking confidence; execution now happens only after the agent explicitly chooses `endpoint_id`
- fix: codex harness artifacts now store collector status (`ready_for_review` / `fail` / `skip`) instead of auto-grading `needs_review`, so pass/fail/skip comes from the in-thread agent review rather than the harness itself
- fix: codex harness now writes a compact review-queue sidecar with top candidates, signal tags, and execute commands so batch shortlist judging can happen in-thread without reopening the full artifact
- fix: codex harness now shells out to the CLI through explicit child-process buffering instead of Bun pipe readers, avoiding stuck batch evals after CLI timeouts/kill paths
- fix: review-queue fallback ordering now prefers replay/API candidates over schema-bearing page artifacts, so GitHub/MDN-style shortlist review stops surfacing the document shell above the real data endpoint
- fix: review-queue fallback ordering now demotes third-party negative-score adtech/tracking endpoints below strong page artifacts, so recipe search shortlist review stops preferring DoubleVerify-style junk over real extracted results
- fix: browser-capture session persistence now keeps only first-party cookies for the captured site, reducing replay pollution from third-party adtech cookies
- fix: restore Food Network and Epicurious public recipe-search cases to the Codex stress/agent-targets site lists after they were overwritten
- fix: repair `/v1/stats` npm range fetch helper so Bun can parse `src/api/routes.ts` and the Codex stress harness boots again
- feat: live skill writing can now call the core agent to refine endpoint descriptions plus typed `requires` / `provides` metadata before building the operation graph, with safe heuristic fallback if the model is unavailable
- fix: live semantic skill augmentation now runs on a bounded, relevance-filtered endpoint subset with a hard timeout, so noisy captures stop stalling skill writing on giant adtech payloads
- fix: operation-graph edge building now refuses generic `id` / `identifier` matches, so noisy captures stop chaining unrelated endpoints purely on placeholder bindings
- fix: execute-time truth gating now checks every successful endpoint response against the effective intent, so news blobs, affinity tables, and other wrong-entity payloads stop masquerading as product success
- fix: intent normalization/classification now understands product search rows, stock quotes, and channel/server lists, improving both direct execute projection and false-positive rejection on fresh domains
- fix: browser capture now navigates with `domcontentloaded` + a 20s cap before intent-aware waits, avoiding 60s+ ad-heavy page loads during fresh skill baking
- fix: marketplace resolve now hydrates only a small, domain-prioritized skill subset with per-skill timeouts, so remote-first repeat resolves stop stalling behind slow `getSkill` fanout
- fix: marketplace resolve now uses a shared-embedding remote search pass with conditional global fallback, so remote-first repeat resolves stop paying duplicate domain/global search cost on strong domain hits
- fix: backend search embeddings now clamp/pad to the indexed vector dimensions, preventing marketplace resolve failures when the embedding provider drifts from the requested size
- fix: CLI marketplace resolve now falls back to legacy `/v1/search` + `/v1/search/domain` when the new shared search route is not deployed yet, preventing repeat resolves from regressing to forced live capture during rollout
- docs: split Codex eval lanes into task-shaped `product-success` and broader `stress`, with `public` / `agent-targets` kept as aliases so product claims stop leaning on hostile homepage sweeps
- fix: codex eval review now scores normalized projected payloads and fills common aliases for fields like description, score, rating, sender, and term
- fix: package/model projection now normalizes crates.io search rows and Hugging Face `modelId` rows into stable eval-friendly fields
- fix: template param hydration now infers dev.to-style `tag` bindings from route context for query-based replay endpoints
- fix: post projection now derives dev.to authors from article paths and recovers Lobsters scores from text-heavy list rows
- docs: curated public expansion corpus now includes validated non-dev science/reference/news cases for arXiv, Wiktionary, and NPR, with exact blocked terminals where needed
- x402 workers can now force `mainnet` payment terms outside production via `X402_NETWORK_MODE`, which unblocks Lobster wallet e2e against staging.
