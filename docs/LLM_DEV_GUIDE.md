# LLM-Friendly Extension Layout

This repo is designed to be iterated on by agents. The main principle is:

- Keep the entrypoint tiny.
- Put large, frequently edited blocks (tool schemas, tool implementations, helpers) into focused modules.
- Prefer dependency injection for plugin wiring so tools remain easy to unit-edit.

## Where Things Live

- `index.ts`
  - Thin entrypoint that re-exports the OpenClaw plugin.
- `src/plugin/plugin.ts`
  - Plugin composition root: reads config, initializes shared state/services, registers hooks.
  - Delegates tool construction to `src/plugin/tools/index.ts` (via `src/plugin/tools.ts` re-export).
- `src/plugin/tools.ts`
  - Backwards-compatible re-export (kept stable for imports; implementation lives in `src/plugin/tools/`).
- `src/plugin/tools/`
  - One file per tool (and shared helpers). This is the main place future agents will edit.
  - Uses a `ToolDeps` object so the plugin can pass in runtime state and helpers.
- `src/plugin/schemas.ts`
  - JSON schemas for tool parameters (kept separate so tool code doesn’t get buried).
- `src/plugin/naming.ts`
  - Small naming helpers (`toPascalCase`).
- `src/plugin/browser-session-manager.ts`
  - Owns the shared CDP browser instance + per-service tab/session map.
- `src/plugin/otp-manager.ts`
  - Owns the long-lived OTP watcher (opt-in only).

## Common Agent Workflows

1. Modify a tool’s behavior:
   - Edit `src/plugin/tools/<tool>.ts`.
   - If you change parameters, update `src/plugin/schemas.ts`.
2. Modify plugin boot/config or shared services:
   - Edit `src/plugin/plugin.ts`.
3. Add a new helper that multiple tools share:
   - Add a small module under `src/plugin/` (or a more specific folder under `src/`), then import it from tools.

## Guardrails

- Keep tool parameter schemas stable unless you’re intentionally making a breaking change.
- Any new “global” state should be passed through `ToolDeps` rather than captured implicitly.
- Prefer small, named helpers over long nested blocks (especially in tool implementations).

## E2E Tests

- Unit tests: `bun run test`
- Integration (real backend, no mocks): `bun run test:e2e`

The E2E backend is a dedicated docker compose stack that runs:
- reverse-engineer on `http://127.0.0.1:4112`
- postgres on `localhost:5433` (isolated from any dev DB)

Config / overrides:
- `E2E_REAL_BACKEND_URL`: attach to an already-running backend (skip start/stop)
- `E2E_BACKEND_PATH`: path to the `reverse-engineer` repo (docker build context)
  - Auto-discovered for Codex worktrees, otherwise set explicitly.
- `E2E_BACKEND_START`: `docker` (default) | `pnpm` | `none`
- `E2E_BACKEND_TEARDOWN=down`: automatically `docker compose down -v` after tests (only if tests started the stack)

Files:
- `test/e2e/reverse-engineer.e2e.compose.yml`
- `test/e2e/reverse-engineer.e2e.env`

## OCT (Black-Box Gateway E2E)

These tests run a real `openclaw gateway` process and invoke tools via `POST /tools/invoke`.
They are useful to catch integration issues that unit tests cannot (plugin loading, auth,
gateway wiring, tool invocation format).

- Local: `bun run test:oct`
  - Uses your local `openclaw` binary.
  - Marketplace suite requires starting an ephemeral gateway:
    - `OCT_CAN_START_GATEWAY=1 bun run test:oct`
- Docker: `bun run test:oct:docker`
  - Uses `test/oct/docker/Dockerfile` (OpenClaw image) and runs `scripts/test-oct.sh` inside.
  - Uses a real reverse-engineer backend on the host (started via `test/e2e/reverse-engineer.e2e.compose.yml` if needed).
