# Codebase Structure

**Analysis Date:** 2026-04-01

## Directory Layout

```
unbrowse/
├── src/                     # Core skill engine (shared between monorepo and packages/skill/)
│   ├── cli.ts               # CLI entrypoint — wraps local HTTP API
│   ├── server.ts            # Fastify server factory
│   ├── index.ts             # Server process entrypoint
│   ├── single-binary.ts     # Bun --compile entrypoint (serve vs CLI dispatch)
│   ├── router.ts            # Router utilities
│   ├── domain.ts            # Registrable domain normalization
│   ├── intent-match.ts      # Intent scoring and projection
│   ├── template-params.ts   # URL template binding/extraction
│   ├── session-logs.ts      # Session log persistence
│   ├── telemetry.ts         # Route trace emission
│   ├── logger.ts            # Namespace-prefixed stderr logging
│   ├── debug-trace.ts       # Debug trace file writing
│   ├── version.ts           # TRACE_VERSION, CODE_HASH, GIT_SHA constants
│   ├── api/
│   │   └── routes.ts        # All Fastify route registrations
│   ├── auth/
│   │   ├── index.ts         # Interactive login, browser auth extraction
│   │   ├── browser-cookies.ts  # Chrome/Firefox SQLite cookie reader
│   │   └── runtime.ts       # LocalAuthRuntime, AuthStrategy types
│   ├── capture/
│   │   ├── index.ts         # captureSession, executeInBrowser, triggerAndIntercept
│   │   ├── prefetch.ts      # Prefetch capture helpers
│   │   └── rsc.ts           # Next.js RSC wire format parsing
│   ├── cli/
│   │   └── shortcuts.ts     # CLI shortcut builders (findTask, buildDepsGraph, planExecution)
│   ├── client/
│   │   ├── index.ts         # Backend API client, local config, skill cache
│   │   └── graph-client.ts  # Graph-specific backend calls
│   ├── execution/
│   │   ├── index.ts         # executeSkill, executeEndpoint, rankEndpoints
│   │   ├── retry.ts         # withRetry, isRetryableStatus
│   │   └── search-forms.ts  # isStructuredSearchForm, detectSearchForms
│   ├── extraction/
│   │   └── index.ts         # DOM extraction helpers
│   ├── graph/
│   │   ├── index.ts         # buildSkillOperationGraph, getSkillChunk, computeReachableEndpoints
│   │   ├── agent-augment.ts # LLM endpoint semantic enrichment
│   │   ├── local-fixtures.ts # Test fixtures for graph
│   │   ├── local-harness.ts # Local test harness
│   │   ├── planner.ts       # DAG execution planner (fetchDagAdvisoryPlan)
│   │   ├── session.ts       # Session-scoped graph state
│   │   └── trace-store.ts   # Execution trace persistence
│   ├── kuri/
│   │   └── client.ts        # Kuri HTTP wrapper (CDP broker, DO NOT EDIT without explicit instruction)
│   ├── marketplace/
│   │   └── index.ts         # publishSkill, getSkill, mergeEndpoints facade
│   ├── orchestrator/
│   │   ├── index.ts         # resolveAndExecute — main routing/orchestration brain
│   │   ├── dag-advisor.ts   # Re-exports from graph/planner.ts
│   │   ├── dag-feedback.ts  # DAG edge upsert, negative/positive feedback recording
│   │   ├── first-pass-action.ts  # Browser fallback on first-pass action
│   │   └── passive-publish.ts    # Background skill publish queue
│   ├── payments/
│   │   ├── index.ts         # Payment integration
│   │   └── wallet.ts        # Wallet management
│   ├── ratelimit/
│   │   └── index.ts         # Fastify rate limiter plugin, ROUTE_LIMITS config
│   ├── reverse-engineer/
│   │   ├── index.ts         # extractEndpoints, extractAuthHeaders
│   │   ├── bundle-scanner.ts # JS bundle route extraction
│   │   └── description-prompt.ts  # LLM endpoint description generation
│   ├── runtime/
│   │   ├── browser-access.ts  # BrowserAccessConfig, DEFAULT_BROWSER_ACCESS
│   │   ├── browser-host.ts    # Browser host integration
│   │   ├── lifecycle.ts       # attributeLifecycle, LifecycleEvent, LifecyclePhase
│   │   ├── local-server.ts    # ensureLocalServer, spawnServer, PID management
│   │   ├── paths.ts           # getPackageRoot, getUnbrowseHome, getServerPidFile
│   │   ├── setup.ts           # runSetup, SetupReport
│   │   └── supervisor.ts      # LocalSupervisor, SUPPORTED_HOSTS, HostType
│   ├── transform/
│   │   ├── index.ts           # applyProjection, inferSchema, buildEntityIndex
│   │   ├── drift.ts           # detectSchemaDrift
│   │   └── schema-hints.ts    # generateExtractionHints
│   ├── types/
│   │   ├── index.ts           # Re-exports from skill.ts
│   │   └── skill.ts           # All canonical types: SkillManifest, EndpointDescriptor, etc.
│   ├── vault/
│   │   └── index.ts           # storeCredential, getCredential (keytar + encrypted file fallback)
│   └── verification/
│       ├── index.ts           # schedulePeriodicVerification
│       └── matrix.ts          # Verification matrix utilities
│
├── packages/
│   └── skill/               # Publishable npm package (unbrowse)
│       ├── src/             # SYMLINKED to ../../src — single source of truth
│       ├── vendor/
│       │   └── kuri/        # Bundled Kuri binaries per platform
│       │       ├── darwin-arm64/kuri
│       │       ├── darwin-x64/kuri
│       │       ├── linux-arm64/kuri
│       │       └── linux-x64/kuri
│       ├── bin/             # npm bin scripts
│       ├── packed-src/      # Packed source snapshot for release
│       ├── runtime-src/     # Runtime-specific source
│       ├── package.json     # npm package manifest (name: "unbrowse")
│       ├── tsconfig.json
│       └── SKILL.md         # Published skill documentation
│
├── backend/                 # Cloudflare Worker — marketplace API
│   ├── src/
│   │   ├── index.ts         # Worker entrypoint
│   │   ├── tos.ts           # Terms of service
│   │   ├── types.ts         # Shared backend types
│   │   ├── middleware/      # Auth middleware, etc.
│   │   ├── routes/          # Route handlers (skills, agents, search, graph, stats, etc.)
│   │   └── services/        # Business logic (marketplace, discovery, scoring, attribution, etc.)
│   ├── wrangler.toml        # Cloudflare Worker config
│   └── package.json
│
├── frontend/                # Next.js landing page
│   ├── src/                 # Next.js app source
│   ├── next.config.ts
│   ├── wrangler.jsonc       # Cloudflare Pages config
│   └── package.json
│
├── evals/                   # Evaluation harness and artifacts
│   ├── codex-harness.ts     # Main eval harness (extend this, not parallel harnesses)
│   ├── codex-auth-runner.ts # Auth eval runner
│   ├── codex-auth-runner-lib.ts
│   ├── campaigns/           # Eval campaign configs
│   ├── codex-harness-last-run.json         # Artifact of record
│   ├── codex-harness-last-run.review-queue.json  # Compact shortlist for agent review
│   └── *.json               # Per-case eval run artifacts
│
├── scripts/                 # Build, release, testing scripts
│   ├── build.sh             # Main build script
│   ├── sync-skill.sh        # Sync packages/skill/ to unbrowse-ai/unbrowse
│   ├── sync-skill-md.ts     # Sync SKILL.md
│   ├── check-packaged-kuri.sh  # Verify packaged Kuri binary is functional
│   ├── release-announce.ts  # Release announcement generator
│   ├── generate-release-notes.ts
│   ├── precommit.sh         # Pre-commit hook
│   └── setup.sh             # Dev environment setup
│
├── tests/                   # Test suite (all real, no mocks)
│   ├── *.test.ts            # Unit and integration tests (100+ files)
│   └── README.md
│
├── submodules/              # Git submodules
│   ├── kuri/                # Kuri Zig source
│   └── openclaw-unbrowse-plugin/  # OpenClaw plugin
│
├── docs/                    # Documentation
├── integrations/            # Integration examples
├── examples/                # Usage examples
├── skills/                  # Stored skill files
├── traces/                  # Local execution traces
├── package.json             # Monorepo root (bun workspaces)
├── bun.lock
├── tsconfig.json
├── biome.json               # Linting/formatting config
├── CLAUDE.md                # AI agent instructions
├── CHANGELOG.md
├── SKILL.md                 # Skill documentation
└── version.json             # Version tracking
```

---

## Key File Locations

**Entry Points:**
- `src/index.ts`: Server process entrypoint (npm package mode, spawned by CLI)
- `src/cli.ts`: CLI entrypoint, 981 lines, all commands implemented here
- `src/single-binary.ts`: Bun --compile binary entrypoint (serve vs CLI dispatch)
- `packages/skill/bin/`: npm bin scripts that invoke the CLI

**Configuration:**
- `tsconfig.json`: TypeScript config (monorepo root)
- `biome.json`: Linting and formatting (replaces ESLint + Prettier)
- `version.json`: Version tracking (synced with package.json)
- `.env` / `.env.runtime`: Environment variables (never commit, never read contents)

**Core Logic:**
- `src/orchestrator/index.ts`: 3,634 lines — the routing brain; resolveAndExecute lives here
- `src/capture/index.ts`: 1,479 lines — browser capture via Kuri
- `src/execution/index.ts`: 2,900 lines — skill execution, endpoint ranking
- `src/reverse-engineer/index.ts`: 1,350 lines — HAR parsing to endpoint descriptors
- `src/graph/index.ts`: 925 lines — operation graph, DAG
- `src/kuri/client.ts`: 889 lines — Kuri HTTP wrapper (DO NOT edit without explicit instruction)
- `src/client/index.ts`: 744 lines — backend client and local config

**Types:**
- `src/types/skill.ts`: All canonical types — `SkillManifest`, `EndpointDescriptor`, `SkillOperationGraph`, etc.

**Testing:**
- `tests/*.test.ts`: All tests live flat in `tests/`. 100+ test files.
- `evals/codex-harness.ts`: Canonical eval harness for product success and stress suites

---

## Naming Conventions

**Files:**
- Kebab-case: `local-server.ts`, `browser-cookies.ts`, `bundle-scanner.ts`
- Index files: `src/<module>/index.ts` is the public surface of each module
- Test files: `tests/<subject>.test.ts` (flat directory, no subdirectories)

**Directories:**
- Lowercase, single word or kebab-case: `capture/`, `reverse-engineer/`, `runtime/`

---

## Where to Add New Code

**New API endpoint:**
- Handler logic: `src/orchestrator/index.ts` or new file in appropriate module
- Route registration: `src/api/routes.ts` (add `app.post/get/...`)
- Rate limit: add to `ROUTE_LIMITS` in `src/ratelimit/index.ts`

**New CLI command:**
- Implementation: `src/cli.ts` — add a case in the main command dispatch block
- Shared shortcut helpers: `src/cli/shortcuts.ts`

**New capture behavior:**
- `src/capture/index.ts` — extend `captureSession()` or add a new exported function

**New endpoint execution strategy:**
- `src/execution/index.ts` — extend `executeEndpoint()` strategy dispatch

**New graph operation:**
- `src/graph/index.ts` — add to operation graph construction

**New type:**
- `src/types/skill.ts` — all canonical domain types live here

**New test:**
- `tests/<subject>.test.ts` — flat alongside existing tests

**New eval case:**
- Extend `evals/codex-harness.ts` or add a case to the existing campaign files
- Do not create parallel eval harnesses

**New backend route (cloud API):**
- `backend/src/routes/<name>.ts`
- Register in `backend/src/index.ts`

**New backend service:**
- `backend/src/services/<name>.ts`

---

## Special Directories

**`packages/skill/vendor/kuri/`:**
- Purpose: Pre-built Kuri binaries bundled with npm package
- Generated: Yes (from Kuri Zig build)
- Committed: Yes (required for npm install to work without Zig)
- Do not manually edit; run `bash scripts/check-packaged-kuri.sh` when touching

**`packages/skill/src/`:**
- Purpose: Symlink to `../../src` — single source of truth
- Generated: Yes (symlink)
- Committed: No (symlink target is committed)

**`evals/`:**
- Purpose: Eval artifacts, harness scripts, campaign configs
- Key files: `codex-harness-last-run.json` (artifact of record), `codex-harness-last-run.review-queue.json` (compact shortlist)
- Do not commit LLM-generated eval results unless intentional

**`traces/`:**
- Purpose: Local execution traces written by `emitRouteTrace()` and `writeDebugTrace()`
- Generated: Yes (at runtime)
- Committed: No

**`submodules/kuri/`:**
- Purpose: Kuri Zig source (git submodule)
- Binary builds land in `packages/skill/vendor/kuri/<target>/`

**`~/.unbrowse/` (runtime home, not in repo):**
- `config.json` — API key, agent ID
- `profiles/<domain>/` — per-domain Chrome profile dirs
- `skill-cache/` — local skill manifest cache
- `run/server-*.json` — PID files
- `logs/server-autostart.log` — server spawn log
- `route-cache.json` — persisted route cache (24h TTL)
- `domain-skill-cache.json` — persisted domain skill cache (7-day TTL)
- `bin/kuri` — cached Kuri binary

---

*Structure analysis: 2026-04-01*
