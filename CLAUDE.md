# CLAUDE.md

## Project

Unbrowse — API-native agent browser powered by Kuri. Discovers internal APIs (shadow APIs) from real browsing traffic and progressively replaces browser calls with cached API routes. Monorepo with bun workspaces.

## North Star

100x traction in one month (Apr 2 — May 2 2026). Every action should be evaluated against this. If it doesn't drive installs, usage, or retention — don't do it.

Baselines (Apr 2): 611 stars, 5.4K npm downloads, 819 keys, 197 WAU, 88 executions, 3 marketplace endpoints.

Reduce the number of steps to achieve any goal with Unbrowse. Continuously self-optimize by running new use cases, identifying where too many steps are needed, and fixing the pipeline so fewer steps are required next time.

**Stickiness strategy:** Make Unbrowse the default browser for every agent via plugin + MCP. If Unbrowse is the MCP server agents call for ANY web task, it becomes infrastructure — not a tool you choose, but the layer everything routes through. Priority: OpenClaw plugin (exists v0.7.13), Claude MCP server (exists), LangChain/CrewAI integrations (code written).
## Architecture

- **Kuri is the primary browser** (Zig-native CDP broker, 464KB, ~3ms cold start). Unbrowse is the intelligence layer on top.
- **`HEADLESS=false`** is required when spawning Kuri — enables stealth extension (anti-bot) + `--user-data-dir` for persistent Chrome profile.
- **Cookie injection**: on `go`/`goto`, cookies are extracted from user's real Chrome/Firefox SQLite DB and injected into Kuri's tab via `setCookie`. Kuri auth profiles (Keychain) are loaded/saved per domain automatically.
- **Passive capture**: HAR recording + fetch/XHR interceptor (`INTERCEPTOR_SCRIPT`) run on every browse session. On `close` or navigation, captured traffic goes through the full enrichment pipeline.
- **Full enrichment pipeline** (same for passive and explicit capture): `extractEndpoints` → `extractAuthHeaders` → `storeCredential` → `mergeEndpoints` (with existing domain skill) → `generateLocalDescription` → `augmentEndpointsWithAgent` (LLM semantic metadata) → `buildSkillOperationGraph` → `cachePublishedSkill` → `queueBackgroundIndex` (marketplace publish).
- **Resolve pipeline**: route cache → marketplace → first-pass browser (8s) → browse session handoff (agent drives) → live capture fallback.
- **Browse session handoff**: on resolve miss, if first-pass has a tab, Unbrowse opens a browser session with auth/interceptor and returns `{ status: "browse_session_open", next_step: "unbrowse snap" }`. The calling agent drives the browser; Unbrowse indexes passively.
- **Sync to public repo**: `bash scripts/sync-skill.sh` or manual rsync to `~/Projects/unbrowse-skill` + push to `unbrowse-ai/unbrowse` stable branch.

## Known Issues to Fix

- **Endpoint routing picks wrong template match** — e.g. Reddit r/singularity resolve executed r/programming endpoint instead. URL template params need better semantic matching, and skill/endpoint descriptions should be reverse-engineered by the LLM to capture what each endpoint actually does (subreddit name, query params, etc.).
- **Kuri HAR misses async fetch/XHR** — HAR recording via CDP doesn't capture all requests on SPAs. The JS interceptor (`INTERCEPTOR_SCRIPT`) catches what HAR misses. Both sources must be merged on close.
- **Stale marketplace skills** — old skills with non-functional endpoints still rank high in resolve. Need staleness detection + auto-deprecation.
- **X.com timeline API not captured passively** — X's GraphQL HomeTimeline uses POST with massive JSON body that `extractEndpoints` filters out. Need to handle GraphQL POST endpoints with `operationName` extraction.
## Structure

- `src/` — shared skill engine (capture, reverse-engineer, execute)
- `backend/` — Cloudflare Worker API (marketplace, stats)
- `frontend/` — Next.js landing page
- `packages/skill/` — isolated publishable skill package (src/ symlinks to root)

## Conventions

- All notable changes must be written into `CHANGELOG.md`
- Use conventional commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`
- Use `bash scripts/sync-skill.sh` to publish skill changes to `unbrowse-ai/unbrowse`
- Kuri must work as a bundled runtime from the package/monorepo vendor path. Do not require end users to install Zig or a separate `kuri` binary.
- When touching Kuri discovery, packaging, runtime paths, or `packages/skill`, run `node packages/skill/scripts/assert-kuri-vendor.mjs`.

## bench-local (fastest iteration loop)

Primary loop when investigating coverage regressions: `bash scripts/bench-local.sh --use-source --corpus-file F --timeout 90`. Uses `bun src/cli.ts` inline (no package reinstall, no server spawn, no CI flakiness). Writes `.bench-local/{results.jsonl,evidence.csv,*.out}` + prints the rubric tally on stderr.

### Evidence fields the agent reads

Every row in `results.jsonl` / `evidence.csv` includes:

- `source` — `marketplace` | `live-capture` | `dom-fallback` | `cache` | `` (no response)
- `trace_success` + `trace_skill_id` — top-level trace outcome
- `has_available_operations` + `n_operations` — shortlist size
- `error_code` + `error_message` — what the product returned
- `captured_html_bytes`, `captured_text_bytes`, `captured_title`, `captured_api_calls`
- `captured_intent_verdict`, `captured_intent_reason` — `assessIntentResult` on stripped text
- `filter_rejections` — JSON map of `{reason: count}` from extractEndpoints (`not_api_like`, `score_non_positive`, `body_not_json_or_html`, `domain_mismatch`, `semantic_entity_mismatch`, `rsc_payload`, `ad_response`, `cloudflare_challenge`, `protobuf_unparseable`)
- `browser_block_signals` — JSON list of signals: `challenge_title`, `vendor:cloudflare|perimeterx|datadome|imperva_incapsula|akamai_bot_manager|captcha_vendor|shape_security|kasada`, `sparse_capture_mostly_noise`, `empty_capture`, `no_html_many_apis` (kuri getPageHtml failed but network fired)
- `capture_diagnostic` — set on `No relevant endpoint discovered` rejection path, one of: `no_endpoints_extracted` (browser-blocked upstream), `all_endpoints_filtered_by_noise_rules` (ranker killed everything), `endpoints_scored_below_relevance_threshold` (scoring issue)
- `total_endpoints_captured` — raw count before ranking, transparency for the above diagnostic

### Agent rubric for classifying bench-local rows

Apply in order (first match wins):

| Bucket | Condition | Counted? |
|---|---|---|
| `BROWSER_BLOCK` | `browser_block_signals` contains `vendor:*`, `challenge_title`, or `no_html_many_apis` | Excluded from coverage |
| `BROWSER_BLOCK` | `capture_diagnostic` in (`no_endpoints_extracted`, `all_endpoints_filtered_by_noise_rules`) | Excluded from coverage |
| `AUTH_GATED` | `error_code == "auth_required"` | Excluded from coverage |
| `PASS` | `has_available_operations == true && n_operations > 0` | ✓ Pass |
| `PASS` | `trace_success == true && source == "dom-fallback"` | ✓ Pass |
| `PASS` | `trace_success == true && source == "direct-fetch"` | ✓ Pass (raw body returned) |
| `SPARSE_REVIEW` | `browser_block_signals` contains only `sparse_capture_mostly_noise` (no vendor) | Agent judges in-thread |
| `PRODUCT_FAIL` | anything else | ✗ Fail |

Coverage metric: **`PASS / (PASS + PRODUCT_FAIL + SPARSE_REVIEW)`**. Never include browser-blocked or auth-gated sites in the denominator — they're not our bug to fix. The stop hook's "100% coverage unless browser-blocked" maps directly to this formula.

### When a row is `SPARSE_REVIEW`

Read `rejected_samples` and `captured_title` for that row's `.out` file. If the rejected URLs look like pure anti-bot telemetry (perimeterx/datadome/cloudflare collectors, tracking beacons, data: URLs), reclassify as `BROWSER_BLOCK`. If they look like real data endpoints the filter ate, add it to `.bench-learned-problems/` as a new product issue and extend the extractor.

### When a row is `PRODUCT_FAIL`

Look at `filter_rejections`: if one bucket dominates, read the corresponding rejected_samples to see if real data endpoints were dropped. Use the pattern from commit 688c79ad (graphql bypass, sibling-subdomain bypass, SPA URL convention bypass) to add targeted filter relaxations. Always add a matching test to `tests/extraction-filter-bypass.test.ts` so the unblock can't silently regress.

## Codex Eval Harness

### Agent Eval (manual, agent-driven)

- Skill: `/unbrowse-eval` — the agent browses each site, indexes, resolves, executes, and verifies
- Cases: `evals/codex-cases.popular-sites.json`
- Results: `evals/unbrowse-eval-last-run.json`
- Programmatic shortlist (resolve-only): `bun run eval:agent`
- Add cases: `/unbrowse-eval --add` or edit the JSON directly
- Each case runs from a fresh state (kill unbrowse/kuri between cases)
- The eval set should grow over time — add sites you test manually

### Codex Eval (programmatic, resolve-only)

- Refresh the local npm package first for manual smoke checks:
  - `cd packages/skill && npm pack`
  - install the tarball into a temp dir
  - use the installed `./node_modules/.bin/unbrowse` binary
- Canonical interactive eval path: `bun run eval:codex`
- Canonical product-success suite: `bun run eval:codex:product-success`
- Stress suite: `bun run eval:codex:stress`
- Compatibility aliases:
  - `bun run eval:codex:public` -> product-success
  - `bun run eval:codex:agent-targets` -> stress
- Use product-success for product claims:
  - task/result pages
  - param-seeded search tasks
  - resolve -> agent review -> optional execute
- Use stress for breadth only:
  - benchmark-style sites
  - niche public forums/search pages
  - homepage-heavy / hostile surfaces
- Final evaluation happens in-thread by the agent reviewing the artifact
- Every eval case stops at resolve; artifact stores collector status only (`ready_for_review`, `fail`, `skip`)
- The agent judges shortlist quality in-thread; execute is optional and only for deeper validation
- Pass `--params '{...}'` when you need to prove the agent populated query/template inputs instead of relying on query state already present in the page URL
- Use one case first; only use case files after the single case passes
- Prefer `--intent ... --url ... --force-capture` while fixing regressions
- Artifact of record: `evals/codex-harness-last-run.json`
- Compact shortlist view: `evals/codex-harness-last-run.review-queue.json`
- Read artifact before patching again:
  - resolve excerpt
  - deferred endpoint shortlist
  - selected order
  - `agent_review.execute_candidates`
  - direct-result excerpt when resolve already returned structured data
  - query source (`url`, `params`, or `mixed`)
  - graph selection + dependency-walk summary
  - local signals
- Use the review-queue sidecar for batch agent judging:
  - top candidates only
  - compact signals (`schema`, `templated_url`, `page_artifact_risk`, ...)
  - direct execute commands
- If auth is needed, make sure local vault/browser cookies already exist first
- Do not add new parallel eval harnesses; extend `evals/codex-harness.ts` or its helpers instead

## Releases

When asked to release, follow this flow:

1. Read commits since last tag: `git log $(git describe --tags --match='v*' --abbrev=0)..HEAD --format="%s"`
2. Read the diff of user-facing code (src/, packages/, SKILL.md, README.md)
3. Write polished, user-facing release notes to `.release-notes.md` (see format below)
4. Run `bun run release:preview` — tests, bumps version, tags, pushes, waits for npm, runs remote agent-xp
5. The tag push triggers CI which deploys backend + frontend and syncs + releases the skill repo

### Post-release agent experience review (MANDATORY)

After every release, run the agent experience harness and **judge the artifacts yourself**:

```bash
bash scripts/agent-experience-test.sh --remote lekt8@89.169.121.108
```

This outputs JSON with real workflow artifacts. Review each task:

| Task | Pass if | Fail if |
|------|---------|---------|
| health | `status: "ok"`, version matches release | missing, wrong version |
| resolve | `available_operations` has 1+ endpoints with `endpoint_id` | empty ops, error |
| execute | `success: true`, `status_code: 200`, response has domain-relevant data | empty data on `--raw`, error |
| search (parameterized) | agent-filled `{q}` param returned results | empty after param fill |
| feedback | `ok: true` | error |
| browse_go | `ok: true`, `session_id` present | all 3 retries failed = investigate |
| browse_eval | result contains page content (title, h1, body length) | CDP error, empty |
| browse_snap | a11y tree with `[e0]` root | empty snapshot |
| browse_close | `ok: true`, `endpoint_count >= 0` | error |

If execute returns `data: []` with `--extract`, retry with `--raw` — extraction path mismatch is not a pipeline failure. Judge the raw response.

If browse skips on remote (cold Kuri start), that's a known timing issue — not a release blocker unless resolve/execute also fail.

**Do not ship a release without reviewing these artifacts.** Grep-based pass/fail is not sufficient — the agent must judge whether the data makes sense for the intent.

### Release notes format (.release-notes.md)

Write for developers and AI agent builders. Focus on what users can do now, not implementation details. Skip internal/backend-only changes. Use this structure:

```
## What's New
(1-2 sentences per feature)

## Fixes
(1 line per fix)

## Performance
(1 line with before/after numbers if available)
```

Omit empty sections. No emojis. No file paths or function names.

### Config

- `release-it` with `@release-it/conventional-changelog` (config: `.release-it.json`)
- Versions synced across: `package.json`, `packages/skill/package.json`, `version.json`
- Do not bump versions or create tags manually — `release-it` handles it

## GitHub

- Only create PRs and issues — do not push directly to main
- Secrets needed for releases: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SKILL_REPO_TOKEN`

- **`src/kuri/client.ts` is now extended by Unbrowse** — auth profile methods, `HEADLESS=false`, cookie injection. Coordinate with Kuri submodule on `adding-extensions` branch when updating.
- **Never edit `src/kuri/client.ts`** unless explicitly asked. Kuri is a separately maintained Zig binary; its Node client wrapper is fragile and tightly coupled.
- **Always kill the running unbrowse server** after `npm i -g` before testing. The old process keeps serving stale code. Run: `pkill -9 -f 'unbrowse|kuri'; sleep 2` then retry.
- **Guard HAR entry iteration**. Kuri HAR entries may have `undefined` headers/response fields. Always use `entry.request.headers ?? []`, never bare `entry.request.headers`.
- **Guard kuri evaluate results**. `kuri.getCurrentUrl` and `kuri.getPageHtml` may return `"[object Object]"` when Kuri's CDP response shape changes. Validate URL starts with `http` and HTML starts with `<`.
- **`rach/restart-base` is the working branch**, not `main`. Main is broken. Do not merge from or rebase onto main.
- **`autoExtract` must be `true`** in `executeBrowserCapture`'s cookie resolution. Setting it to `false` silently skips browser cookie extraction and breaks all gated sites.
- **Packaged CLI spawns a separate server process**. `bun src/cli.ts` runs inline (same process), but `unbrowse` (global install) spawns a detached node+tsx server. Stale servers are the #1 cause of "works from source, broken from package".
- **Never mock in tests**. Tests must hit real endpoints, real files, real functions. Mocked tests pass when prod is broken — they prove nothing. Use live backend URLs (gated behind env vars for CI), real filesystem temp dirs, and actual function calls. If a test can't run without mocking, the code is too coupled — fix the code, not the test.
- **Backend URL is `beta-api.unbrowse.ai`**, not `api.unbrowse.ai`. The `UNBROWSE_API_URL` env var overrides this.

## Testing

- **Always use `/codex` to run tests**. Do not write test assertions by hand — use the `/codex` plugin to generate and execute all unit tests, e2e tests, and regression tests. This prevents fabricated/hallucinated test results.
- **Never fake a passing test**. If a test can't be run, say so. Do not write a test that asserts hardcoded expected values you haven't verified by actually running the code.
- **Run tests after every code change**. Use `bun test <file>` for targeted runs. All graph/DAG tests: `bun test tests/graph-*.test.ts tests/dag-*.test.ts`. Sanitization: `bun test tests/sanitize-for-publish.test.ts`.
- **Tests must hit real code paths** — no mocks, no stubs, no fake HTTP responses. If a test needs a network call, gate it behind an env var for CI, don't mock it.
- **Bug fix protocol**: when a bug is reported, write a failing test FIRST that reproduces it, then fix the code and verify the test passes.

## Session Start Protocol

When Lewis starts a conversation about pipeline, fundraising, or sprint progress, proactively run these checks:

### Pipeline Watchdog
1. Read memory `project_fundraise_status_apr1.md` for last-known pipeline state
2. Check Gmail (via `gws gmail`) for recent investor emails — look for replies to SAFEs, lead candidates, and follow-on threads
3. Query Telegram (via `telegram-query` skill) for DM activity from key investor chat IDs listed in `reference_investor_contacts.md`
4. Cross-reference: flag anyone who's been silent >5 days, anyone where Lewis owes a response, any SAFEs unsigned >3 days
5. Update memory with any new signals found

### Sprint Tracker
1. Pull Linear issues for "20x Traction Sprint (Apr 1-14)" — show status (backlog/in-progress/done)
2. Check traction API (`https://launch.unbrowse.ai/api/traction`) and stats API (`https://beta-api.unbrowse.ai/v1/stats/summary`) for current metrics
3. Compare against sprint targets in `project_20x_sprint.md`
4. Flag overdue issues and blockers

### Content & Marketing Pulse
1. Check Typefully (via `typefully` skill) for scheduled/published posts
2. Check X engagement on recent @getFoundry and @lekt8_ posts
3. Compare against content plan in Linear (GET-12 through GET-17)
4. Flag content that's drafted but not posted

### Nascent GP Prep (active until Apr 10 2026)
1. Track days until Nascent GP meeting (Apr 10, 9am PST)
2. Ensure deck, demo, team intros are ready
3. Pull Granola notes from Jack meeting (`not_TDTFi83iGBdbZD`) for talking points
4. Flag any DD materials Jack's team has requested

### Key investor follow-up cadences
- **SAFEs sent**: nudge after 3 days, escalate after 7
- **Post-meeting silence**: follow up after 3 days, nudge again at 7, flag at 14
- **DD in progress**: check in weekly, send any requested materials within 24h
- **Connectors**: ping monthly for intros, update them on progress when there's news
- **"Keep us posted"**: re-engage when there's a concrete trigger (lead closes, traction spike, paper published)

## GTM Execution Protocol — 100x Flywheel

The flywheel: **Discovery → Install → Use (=Mine) → Earn → Retain → Share → More Discovery**
Every layer below feeds this. If an action doesn't feed the flywheel, don't do it.

### Layer 0: AI Search Visibility (GEO) — HIGHEST LEVERAGE, LOWEST EFFORT
Unbrowse is a tool for AI agents but is invisible to AI search. Fix this first.
| Skill | What it does | Priority |
|-------|-------------|----------|
| `geo-crawlers` | Unblock AI crawlers (GPTBot, ClaudeBot, etc.) in robots.txt | **P0 — DO FIRST** |
| `geo-llmstxt` | Fix llms.txt for AI consumption | P0 |
| `geo-citability` | Make content citable by AI (definition blocks, FAQ, stats) | P1 |
| `geo-schema` | Add structured data (Organization, SoftwareApplication, ScholarlyArticle) | P1 |
| `geo-brand-mentions` | Build brand presence on platforms AI cites (Reddit, GitHub, Wikipedia) | P1 |
| `geo-platform-optimizer` | Optimize for Google AI Overviews, Perplexity, ChatGPT search | P1 |
| `geo-content` | E-E-A-T content quality for AI citability | P2 |
| `geo-technical` | Technical SEO foundations (SSR, Core Web Vitals, crawlability) | P2 |
| `geo-audit` | Full audit — run monthly to track score improvement from 35/100 baseline | P2 |
| `geo-report` / `geo-report-pdf` | Generate client-facing reports (useful for investor updates) | P3 |

### Layer 1: Traditional SEO — Organic Search Discovery
| Skill | What it does | Priority |
|-------|-------------|----------|
| `seo-audit` | Full traditional SEO audit | P1 |
| `programmatic-seo` | Create pages at scale for long-tail keywords ("unbrowse vs playwright", "AI agent browser", etc.) | P1 |
| `schema-markup` | Schema.org structured data for rich snippets | P2 |

### Layer 2: Paid Acquisition
| Skill | What it does | Priority |
|-------|-------------|----------|
| `paid-ads` | X Ads, Google Ads, LinkedIn Ads — strategy, copy, targeting | P1 |
Target keywords: "browser automation alternative", "playwright alternative for AI", "AI agent web tool", "MCP browser"

### Layer 3: Content & Social (Awareness → Install)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `unbrowse-typefully-campaigns` | Plan + schedule X campaigns (USE THIS for posting, not x-cli) | P0 |
| `tweet-writer` | Optimize individual tweets | P1 |
| `x-virality` | X algorithm optimization | P1 |
| `create-viral-content` | Auto-activated on content generation | auto |
| `twitter-thread-creation` | Thread structure + hooks | P1 |
| `hacker-news-strategy` | HN timing, title, comment strategy | P1 |
| `product-hunt-launch` | PH launch optimization | P2 (after traction) |
| `content-strategy` | Long-term content planning | P2 |
| `content-marketing` | Content marketing strategy | P2 |
| `content-calendar` | Schedule + track across platforms | P2 |
| `social-content` | Platform-optimized posts (LinkedIn, X, Reddit) | P1 |
| `social-selling-content-generator` | 30+ LinkedIn posts for dev audience | P2 |
| `reddit` / `reddapi` | Search + engage Reddit threads | P1 |
| `hackernews` | Search + engage HN | P1 |

### Layer 4: Email Campaigns (Direct → Install)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `resend-ab-test` | Tournament-style email AB testing (8 variants ready) | P0 |
| `resend-cli` | Send emails, manage contacts | P0 |
| `resend` | Resend API integration | P0 |
| `email-sequence` | Drip campaign design | P1 |
| `cold-outreach` | Cold email to dev communities | P2 |

### Layer 5: Landing Page & Onboarding (Visit → Install → First Value)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `page-cro` | Landing page conversion optimization | P1 |
| `signup-flow-cro` | Install/signup flow optimization | P1 |
| `onboarding-cro` | Post-install activation optimization | P1 |
| `user-onboarding` | Design onboarding flows | P2 |
| `analytics-tracking` | Set up funnel tracking (install → resolve → mine → earn) | P1 |

### Layer 6: Retention & Growth Loops (Use → Earn → Share → More Users)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `referral-program` | Design referral/invite mechanics (earn more when you invite) | P1 |
| `designing-growth-loops` | Self-reinforcing growth mechanisms | P1 |
| `free-tool-strategy` | Free tools that pull developers in | P2 |
| `community-building` | Community growth tactics | P2 |
| `retention-engagement` | Retention improvement tactics | P1 |
| `measuring-product-market-fit` | PMF assessment and tracking | P2 |

### Layer 7: Developer Ecosystem (Integrations = Distribution)
| Skill | What it does | Priority |
|-------|-------------|----------|
| `gtm-developer-ecosystem` | Developer-led adoption programs | P1 |
| `launch-strategy` | Cross-channel launch planning | P2 |
| `marketing-ideas` | Campaign brainstorming | P3 |

When Lewis asks about GTM, growth, marketing, or content — run these checks and take action:

### Pre-Post Checklist (ALWAYS do before posting to any platform)
1. Search the platform for recent posts from the same account — `x-cli tweet search "from:unbrowse" --max 10`
2. Check for duplicate hooks, repeated phrasing, or same links already shared
4. Check which account x-cli is authed as before posting (currently @unbrowse, NOT @getFoundry)
5. **NEVER use x-cli to post tweets** — always use Typefully (`/typefully` skill) for proper scheduling, analytics, and queue management. x-cli is READ-ONLY (search, metrics, monitoring).

### Blog Publisher
- Skill: `/blog-publisher`
- API key: `BLOG_PUBLISH_KEY=6A3Q4N_lAdWQUtTs1biZzqZGl4BlPJVau8wB8dLn5W4`
- Backend endpoint: `POST https://beta-api.unbrowse.ai/v1/blog/publish` (secured by above key in `Authorization: Bearer` header)
- Accepts: `{ slug, title, description, keywords[], content (markdown), deploy: bool }`
- Generates Next.js page from template, updates sitemap, optionally triggers deploy
- Content Factory remote agent drafts to `.content-queue/`, then blog-publisher publishes

### Traction Dashboard (always check first)
1. Hit `https://launch.unbrowse.ai/api/traction` for: stars, npm downloads, WAU, keys, verifications, retention
2. Hit `https://beta-api.unbrowse.ai/v1/stats/summary` for: marketplace endpoints, executions, agents, hit rate
3. Compare against sprint targets in memory `project_20x_sprint.md`
4. Report delta since last check

### Remote Agents (auto-running, check their output)
1. **Daily Traction Snapshot** — commits `DAILY_TRACTION.md` at 9am SGT
2. **Content Factory** — drafts to `.content-queue/YYYY-MM-DD.md` at 7am SGT
3. **Competitor Intel** — `.intel/YYYY-MM-DD.md` Mon+Thu 1pm SGT

### Supply-Side Growth (the flywheel)
The marketplace fills itself via monetary incentive. Users mine by using Unbrowse — every resolve indexes routes, they earn x402 micropayments. DON'T manually seed — drive users who seed organically.
1. **Email campaigns** drive installs → users use Unbrowse → routes get indexed → marketplace fills
2. **Earnings visibility** (GET-10) is the retention hook — users see "$X earned" and keep mining
3. **First mover bonus**: 2x reward rate for first indexer of a domain
4. Mining quickstart doc: `/Users/lekt9/Downloads/_sorted/content/mining_quickstart.md`

### Email Campaigns (Resend)
Already built and ready to fire:
- **Resend API key**: in memory `reference_resend_api_key.md`
- **OpenClaw stargazer emails**: 234 collected, audience ID `b14d5358-0c7e-422f-89d0-49fefc77c483`
- **Unbrowse stargazer emails**: 118 collected
- **8 AB test variants** ready: `/Users/lekt9/Downloads/_sorted/outreach/openclaw_campaign_variants.json`
  - Best hooks: "cosplay", "mcp-hallucination", "scraped-you", "browser-tax"
- **AB test engine**: `python3 ~/.claude/skills/resend-ab-test/scripts/ab-send.py tournament`
- **Stargazer collection script**: `/Users/lekt9/Downloads/_sorted/outreach/` (needs GITHUB_TOKEN for more)
- Skills: `resend-ab-test`, `resend-cli`, `resend`
- Fire when: earnings visibility is live (GET-10) so users who arrive can see the mining incentive

### X/Twitter — Organic + Paid
**Organic:**
- Post 2-3x/day from @getFoundry (product, benchmarks, demos)
- Post 1x/day from @lekt8_ (founder POV, hot takes)
- Use `x-cli` for posting: `x-cli tweet post "text"`
- Monitor: `x-cli me tweets --limit 10`
- Each morning: review `.content-queue/` drafts, tweak, post
- Skills: `tweet-writer`, `x-virality`, `create-viral-content`, `twitter-thread-creation`

**Paid (X Ads):**
- Use `paid-ads` skill for campaign strategy, targeting, ad copy
- Target audiences: AI agent developers, MCP users, "browser automation" interest, Playwright/Puppeteer users
- Ad angles: "3.6x faster than Playwright", "your agent is browsing — mine calls the API", paper credibility
- Landing page: unbrowse.ai with paper link + `npx unbrowse setup`
- Retarget: website visitors, GitHub stargazers (custom audience from email list)
- Budget: TBD — start small ($50-100/day), optimize for installs
- Use `unbrowse-typefully-campaigns` for campaign planning + scheduling

### Content Pipeline
1. Check Linear GET-12 through GET-17 for status
2. Check `.content-queue/` for Content Factory drafts
3. Existing drafts at `/Users/lekt9/Downloads/_sorted/content/`:
   - `paper_drop_x_thread.md` — X thread for paper launch
   - `email_openclaw_stars.md` — email campaigns (2 audiences)
   - `mining_quickstart.md` — how mining works
   - `clawhub_submission.md` — OpenClaw skill directory listing
   - `product_hunt_listing.md` — PH copy
4. Use `x-cli` to check engagement on recent posts
5. Flag: drafted but not posted, posted but low engagement

### Skill Toolbox
| Skill | When to use |
|-------|------------|
| `unbrowse-growth-os` | Full GTM operating system — sprint playbook |
| `unbrowse-typefully-campaigns` | Plan + schedule X campaigns |
| `paid-ads` | X Ads, Google Ads, LinkedIn Ads strategy + copy |
| `resend-ab-test` | Tournament-style email AB testing |
| `resend-cli` | Send emails, manage contacts |
| `tweet-writer` | Optimize individual tweets |
| `x-virality` | Apply X algorithm logic for spread |
| `create-viral-content` | Auto-activated on content generation |
| `twitter-thread-creation` | Thread structure + hooks |
| `hacker-news-strategy` | HN timing, title, comment strategy |
| `product-hunt-launch` | PH launch optimization |
| `launch-strategy` | Cross-channel launch planning |
| `content-strategy` | Long-term content planning |
| `content-calendar` | Schedule + track across platforms |
| `content-marketing` | Content marketing strategy |
| `social-content` | Platform-optimized posts (LinkedIn, X, Reddit) |
| `social-selling-content-generator` | 30+ LinkedIn posts for prospects |
| `reddit` | Search Reddit for engagement threads |
| `hackernews` | Search HN stories + comments |
| `referral-program` | Design referral/invite mechanics |
| `gtm-developer-ecosystem` | Developer-led adoption programs |
| `community-building` | Community growth tactics |
| `marketing-ideas` | Campaign brainstorming |
| `designing-growth-loops` | Self-reinforcing growth mechanisms |
| `measuring-product-market-fit` | PMF assessment |

### Distribution Channels (ranked by impact)
1. **Resend email campaigns** — 352 stargazer emails ready, 8 AB variants, fire when GET-10 ships
2. **OpenClaw** (344K stars) — clawhub listing + plugin already built (v0.7.13)
3. **arXiv paper** — PUBLISHED: https://arxiv.org/abs/2604.00694
4. **X Ads** — paid amplification of best-performing organic posts
5. **HackerNews** — draft ready, use `hacker-news-strategy` for timing
6. **LangChain PR** — code written at `/Users/lekt9/Downloads/_sorted/integrations/langchain/`
7. **CrewAI PR** — code written at `/Users/lekt9/Downloads/_sorted/integrations/crewai/`
8. **Product Hunt** — copy ready, launch after HN traction
9. **Community** — mtnDAO, hackathon builders, agent Discords
10. **Reddit** — r/MachineLearning, r/LocalLLaMA, r/selfhosted, r/webdev
11. **LinkedIn** — use `social-selling-content-generator` for dev audience
12. **Podcast circuit** — MCG done, pitch more AI/dev podcasts
13. **Newsletter sponsorships** — Ben's Bites, The Rundown, AI newsletters

### Growth Flywheel
```
Email/ads drive installs → users resolve (= mine) → routes indexed → x402 earnings visible
    ↓                                                                         ↓
More endpoints → higher hit rate → faster resolves → more agents attracted → more mining
```
The flywheel is monetary: users earn by using the product. Supply creates demand.

### Weekly GTM Review (every Monday)
1. Pull full traction metrics + compare week-over-week
2. Read `.intel/` for competitive intel + content angles
3. Check Resend dashboard for email campaign performance
4. Review X Ads performance (if running)
5. Update sprint memory with actuals
6. Adjust channel mix based on what's converting
7. Draft investor update if metrics moved
8. Plan content calendar for the week
