# Technology Stack

**Analysis Date:** 2026-04-01

## Languages

**Primary:**
- TypeScript 5.7+ — all source code in `src/`, `backend/src/`, `frontend/` (strict mode, ES2022 target)

**Secondary:**
- Zig (for building the Kuri browser engine binary at `submodules/kuri/`; not part of normal dev workflow)
- Shell (build and release scripts in `scripts/`)
- JavaScript (ESM, select config/helper scripts in `packages/skill/scripts/`)

## Runtime

**Development environment:**
- Bun (primary runtime for monorepo dev, test execution, CLI source mode, build scripts)
- Node.js (used in packaged `unbrowse` npm CLI via `tsx` for TypeScript transpilation)

**Package entry point (published npm package):**
- Dist is compiled to ESM JavaScript; packaged CLI spawns a detached Node+tsx server process
- Single-binary builds compile via `bun build --compile` to self-contained executables

**TypeScript config:** `tsconfig.json` — target ES2022, moduleResolution bundler, strict, sourceMap, declaration maps

## Package Manager

**Root monorepo:**
- Bun workspaces (`package.json` workspaces: `packages/*`, `backend`, `frontend`)
- Monorepo version: `2.6.0` (not published; only `packages/skill` is published)
- Lockfile: `bun.lockb` (bun native format)

**Published package (`packages/skill`):**
- npm package name: `unbrowse`
- Version: `2.0.2` (synced by `release-it` via `@release-it/bumper`)
- `tsx ^4.20.6` bundled as a runtime dependency (enables Node.js to execute `.ts` files without a build step)

## Frameworks

**Local server (skill engine):**
- `fastify ^5.7.4` — HTTP API server, default port 6969
- `@fastify/cors ^11.2.0` — CORS for browser/agent access
- `@fastify/rate-limit ^10.3.0` — rate limiting per client

**Backend (Cloudflare Worker):**
- `hono ^4.7.0` — ultralight HTTP framework for the Cloudflare Worker environment (no Node.js APIs)

**Frontend (landing page):**
- `next 16.1.5` — React 19 framework
- `react 19.1.5` / `react-dom 19.1.5`
- `tailwindcss ^4` — utility CSS
- `lucide-react ^0.577.0` — icon library

## Key Dependencies

**Skill engine (root + `packages/skill`):**
- `cheerio ^1.2.0` — HTML parsing for DOM extraction and bundle scanning
- `nanoid ^5.1.5` — random ID generation for skills, endpoints, traces
- `dotenv ^17.3.1` — environment variable loading
- `ws ^8.19.0` — WebSocket client (packaged skill distribution only)
- `keytar ^7.9.0` (optional) — OS keychain integration for credential storage; falls back to AES-256-CBC encrypted file at `~/.unbrowse/vault/credentials.enc`

**Backend (`backend/`):**
- `nanoid ^5.1.6` — IDs
- `@cloudflare/workers-types ^4.20241230.0` (dev) — Cloudflare KV and Worker type bindings
- `wrangler ^3.100.0` (dev) — Cloudflare deployment CLI

**Frontend (`frontend/`):**
- `@opennextjs/cloudflare ^1.15.1` — Next.js adapter for Cloudflare Pages
- `wrangler ^4.67.0` (dev) — Cloudflare deploy tooling for the frontend

## Build Tools

**Kuri binary (browser engine):**
- Built from `submodules/kuri/` using `zig build -Doptimize=ReleaseFast`
- Cross-compiled via `scripts/build.sh` for four platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`
- Output placed in `packages/skill/vendor/kuri/{platform}/kuri`
- Pre-built binaries are committed to the repo; Zig is only required to rebuild from source

**Unbrowse single-binary:**
- `bun build --compile src/single-binary.ts --target bun-{platform}-{arch}`
- Output: `dist/unbrowse-{platform}-{arch}/unbrowse` alongside the matching `kuri` binary
- Script: `scripts/build.sh`

**npm package (`packages/skill`) build:**
- Prepack hook: `bun ../../scripts/sync-skill-md.ts --check && node scripts/prepare-pack.mjs`
- `prepublishOnly` guard: `node scripts/assert-release-flow.mjs`

**Frontend build:**
- Standard: `next build`
- Cloudflare Pages: `opennextjs-cloudflare build && opennextjs-cloudflare deploy`

## Configuration

**Key environment variables (skill engine):**
- `UNBROWSE_API_URL` / `UNBROWSE_BACKEND_URL` — backend URL (default: `https://beta-api.unbrowse.ai`)
- `UNBROWSE_PACKAGE_ROOT` — override package root path detection
- `UNBROWSE_PID_FILE` — server PID file location
- `UNBROWSE_RUN_DIR` — run state directory (default: `~/.unbrowse/run/`)
- `UNBROWSE_TRACES_DIR` — local anonymized trace output (default: `~/.unbrowse/traces/`)
- `UNBROWSE_DISABLE_TRACES=1` — opt out of local telemetry
- `UNBROWSE_FORCE_CAPTURE=0` / `UNBROWSE_FORCE_CAPTURE=1` — force/suppress HAR capture
- `UNBROWSE_NON_INTERACTIVE=1` — suppress interactive prompts (used by spawned server)
- `PORT` / `HOST` — local server listen address (default: `127.0.0.1:6969`)

**Backend (Cloudflare Worker) — set via `wrangler secret put`:**
- `API_KEY` — admin bearer token (legacy)
- `UNKEY_ROOT_KEY` — Unkey API key management root key
- `UNKEY_API_ID` — Unkey API ID (also in `backend/wrangler.toml` as a plain var)
- `EMERGENTDB_API_KEY` — EmergentDB vector/KV API key
- `NEBIUS_API_KEY` — Nebius LLM API key
- `PAYMENT_RECIPIENT` — wallet address for x402 skill-access payments

**Configuration files:**
- `tsconfig.json` — TypeScript compiler options
- `.release-it.json` — release pipeline (bumper, changelog, GitHub release)
- `backend/wrangler.toml` — Cloudflare Worker route and var config
- `version.json` — current version string, synced by `release-it`

## Platform Requirements

**Development:**
- Bun (latest stable) — required for monorepo scripts and test runner
- Node.js (18+) — for packaged CLI path and tsx transpilation
- `sqlite3` CLI — runtime dependency for browser cookie extraction (not bundled, must be on PATH)
- `security` CLI (macOS built-in) — Chrome keychain decryption on macOS
- Zig toolchain — only needed to rebuild kuri from source; pre-built binaries are vendored

**Production (local skill engine):**
- macOS (arm64/x64) or Linux (arm64/x64)
- Chrome or Chromium must be installed; kuri manages CDP connections to it
- Node.js or Bun runtime to execute the published `unbrowse` npm CLI

**Production (backend):**
- Cloudflare Workers runtime (V8 isolates; `compatibility_date = "2024-12-01"`)

**Production (frontend):**
- Cloudflare Pages via `@opennextjs/cloudflare`

---

*Stack analysis: 2026-04-01*
