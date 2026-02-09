# Architecture

This repo contains the Unbrowse OpenClaw extension (the plugin) plus a small marketing site under `server/web/`.
The marketplace backend is external (the `reverse-engineer` repo); this repo only contains the client + test harness.

## Entry Points

- `index.ts`
  - Tiny package entrypoint. Re-exports the plugin implementation.
- `src/plugin/plugin.ts`
  - Plugin composition root:
    - reads config/env
    - initializes shared services (browser/session manager, OTP manager, discovery)
    - wires the marketplace client + wallet state
    - registers tools + hooks

## Tool Layout (LLM-Friendly)

Tools are intentionally split into small modules so agents can edit one tool at a time:

- `src/plugin/tools/index.ts`: constructs the tool list
- `src/plugin/tools/unbrowse_*.ts`: one file per tool
- `src/plugin/schemas.ts`: JSON schemas for tool parameters
- `src/plugin/tools/deps.ts`: `ToolDeps` interface for dependency injection
- `src/plugin/tools/shared.ts`: shared imports/helpers used by tools

See `docs/LLM_DEV_GUIDE.md` for the day-to-day editing workflow.

## Capture + Learn Pipeline

High-level flow:

1. Capture traffic
   - `unbrowse_capture` uses CDP/Playwright to capture XHR/fetch traffic and auth context.
2. Parse requests into an API model
   - `src/har-parser.ts` converts HAR/network records into a normalized request model.
3. Generate a skill package
   - `src/skill-generator.ts` writes an AgentSkills-compatible skill folder:
     - `SKILL.md`: skill definition + endpoint documentation
     - `auth.json`: local auth material (headers/cookies/tokens)
     - `scripts/`: TypeScript helpers/clients

`unbrowse_learn` runs the same pipeline starting from a HAR file.

## Marketplace Integration

- `src/skill-index.ts` is the marketplace client used by `unbrowse_search` and `unbrowse_publish`.
- Download:
  - Free skills return content directly.
  - Paid skills return HTTP 402; the client performs an x402 USDC payment (Solana) and retries with `X-Payment`.
- Publish:
  - Requests are signed with a Solana private key via `X-Wallet-*` headers.

## Wallet

- `src/wallet/keychain-wallet.ts`: stores wallet material (macOS keychain with file fallback for CI/Linux).
- `src/wallet/wallet-tool.ts`: implementation for `unbrowse_wallet`.

## Tests

- Unit tests: `bun run test`
- Real-backend E2E (no mocks): `bun run test:e2e`
  - Uses `test/e2e/backend-harness.ts` which attaches to (or starts) a real backend.
  - Docker stack:
    - `test/e2e/reverse-engineer.e2e.compose.yml`
    - `test/e2e/reverse-engineer.e2e.env`
    - `test/e2e/postgres-init.sql`
- Black-box gateway E2E (OCT): `bun run test:oct` / `bun run test:oct:docker`
  - Uses the vendored harness under `third_party/openclaw-test-suite/`.

