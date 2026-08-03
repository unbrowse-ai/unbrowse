# CLI, MCP Server, SDK & Local Engine

> **At a glance** — one Bun-compiled binary exposes the same engine three
> ways: 60+ CLI commands, ~45 MCP tools over stdio, and an embedded SDK.
> The engine pipeline is capture → index → rank → execute, with secrets
> kept as vault pointers (never plaintext in artifacts). Client payment
> rails (x402 envelope signing, OWS vault, lobster.cash delegation) resolve
> a wallet at request time and always report honest outcomes.

> Surface: everything that runs on the user's machine. Source of truth:
> `src/` and `packages/` at v8.3.0-preview.2.

## 1. CLI

### Entry & dispatch
- Entry point: `src/cli.ts` (single bundled entry, 60+ subcommands
  dispatched via switch).
- Newer verb-based layer: `src/cli-v7/` — 37 operations dispatched through a
  kind map (`src/cli-v7/dispatch/index.ts`), grouped under three verbs
  (build / act / inspect style groupings).
- Run from source: `bun src/cli.ts` (`package.json` script `cli`).

### Command inventory (by area)
| Area | Commands |
|---|---|
| Lifecycle | `setup`, `login`, `register`, `account`, `status`, `restart`, `stop`, `health`, `mcp` |
| Core loop | `index`, `resolve`, `run`, `execute`/`exec`, `search`, `explain`, `publish`, `review`, `feedback`, `annotate` |
| Browser verbs | `go`, `click`, `fill`, `type`, `press`, `select`, `scroll`, `screenshot`, `snap`, `text`, `markdown`, `back`, `forward`, `submit`, `eval`, `close`, `connect-chrome` |
| Auth & secrets | `auth`, `auth-capture`, `cookies`, `browse-cookies` |
| Money | `wallet`, `payment-provider`, `billing`, `earnings`, `flywheel` |
| Skills | `skills`, `skill`, `capture`, `contract` |
| Diagnostics | `stats`, `sessions`, `inspect`, `dashboard`, `corpus-test`, `corpus-run`, `note`, `fetch`, `sync`, `mode`, `plan` |

### Distribution
- npm package `unbrowse` (`packages/skill/package.json`), wrapper
  `packages/skill/bin/unbrowse-wrapper.mjs`.
- Single binaries compiled with `bun build --compile` for five platforms
  (`scripts/build-binaries.sh`); binary entry `src/single-binary.ts`.
- Release attestation headers `X-Unbrowse-Release-Manifest` /
  `X-Unbrowse-Release-Signature` are checked client-side
  (`src/client/index.ts`).

## 2. MCP server
- Implementation: `src/mcp.ts` — JSON-RPC 2.0 over **stdio**; supported
  protocol versions 2024-11-05 through 2025-11-25.
- Launches the same in-process HTTP app the CLI uses
  (`src/runtime/in-process-app.ts`), so MCP and CLI share one engine.
- ~45 tools, `unbrowse_*`-prefixed. Core set: `unbrowse_resolve`,
  `unbrowse_execute`, `unbrowse_run`, `unbrowse_search`,
  `unbrowse_search_endpoints`, `unbrowse_index`, `unbrowse_publish`,
  `unbrowse_skill`/`unbrowse_skills`, `unbrowse_auth_capture`,
  `unbrowse_auth_inventory`, `unbrowse_cookies`, `unbrowse_sessions`,
  `unbrowse_earnings`, `unbrowse_settings`, `unbrowse_health`,
  `unbrowse_stats`, `unbrowse_feedback`, `unbrowse_review`,
  `unbrowse_annotate`, `unbrowse_diagnose`, `unbrowse_trace`,
  `unbrowse_validate`, `unbrowse_spec`, plus the browser verbs
  (`unbrowse_go`, `unbrowse_click`, `unbrowse_fill`, `unbrowse_type`,
  `unbrowse_press`, `unbrowse_select`, `unbrowse_scroll`,
  `unbrowse_screenshot`, `unbrowse_snap`, `unbrowse_text`,
  `unbrowse_markdown`, `unbrowse_submit`, `unbrowse_eval`,
  `unbrowse_close`, `unbrowse_fetch`, `unbrowse_sync`).
- Optional env `UNBROWSE_MCP_V7_DISPATCH` routes tool calls through the v7
  kind-map dispatch (`src/mcp.ts`).
- Resources: cookies, history, vault exposed as MCP resources
  (`src/mcp.ts` textResource helpers). MCP prompts are declared in types but
  handlers are not fully wired (known gap).

## 3. SDK & shim packages (`packages/`)
- `@unbrowse/sdk` — **deprecated**; points to the HTTP-first client. The
  maintained SDK ships inside the main package as `unbrowse/sdk` (and
  `unbrowse/sdk/wallet-standard`) from `packages/skill/dist-sdk/`.
- Drop-in shims that route existing libraries through the Unbrowse cache:
  - Browser automation: `playwright-shim`, `stagehand-shim`
  - Scraping: `firecrawl-shim`
  - HTTP clients: `axios-shim`, `got-shim`, `ky-shim`, `node-fetch-shim`,
    `cross-fetch-shim`, `undici-shim`, `wretch-shim`
  - Agent frameworks: `langchain-js`, `llamaindex`, `mastra`,
    `openai-agents`, `superagent-shim`
  - Search providers: `exa-shim`, `tavily-shim`
  - Python bridges: `py-requests`, `py-httpx`, `py-aiohttp`, `py-urllib3`,
    `py-browser-use`, `py-crewai`, `py-exa`, `py-pydantic-ai`

## 4. Local engine
| Stage | Module | Responsibility |
|---|---|---|
| Capture | `src/capture/index.ts` | Record an interaction for a URL+intent; secret obfuscation (`obfuscate.ts`), template holes (`hole-template.ts`), proof-bound credential holes (`zk-bound-hole.ts`), wallet signature binding (`wallet-bind.ts`), SSR fast path, HTTP fallback (`curl-impersonate-fallback.ts`), escalation on miss (`escalate-on-miss.ts`) |
| Execution | `src/execution/index.ts` | Replay with resolved pointers; anti-bot challenge handlers (`cf-challenge.ts`, `px-challenge.ts`, `akamai-challenge.ts`, `kasada-challenge.ts`); token resolution (`token-resolver.ts`); proxy + server-proxy fallback; drift recovery (`drift-page-recovery.ts`) |
| Indexing | `src/indexer/` | Background queue (`capture-spool.ts`, `queue-store.ts`, `worker.ts`) |
| Ranking | `src/graph/` + `src/intent-match.ts` | Route cache, endpoint ranking, planner, session tracking, decision trace store |

## 5. Auth from the client side
- First run: `unbrowse setup` (`src/cli.ts` `cmdSetup`) →
  `ensureRegistered()` (`src/client/index.ts`) prompts for email, exchanges
  it for an API key against the backend, prompts contribution mode
  (`src/cli-setup.ts`) and optional wallet setup.
- Credentials live in `~/.unbrowse/config.json` (fields: `api_key`,
  `agent_id`, `agent_name`, `email`, `user_id`, ToS acceptance), with
  multi-profile support via `UNBROWSE_PROFILE` →
  `~/.unbrowse/profiles/<name>/config.json` (`src/client/index.ts`).
- Site credentials are never stored as plaintext values in routes: cookies
  cache per-domain (`src/auth/browser-cookies.ts`); vault adapters
  (1Password, Bitwarden, keychain — `src/values/adapters/`) resolve
  pointers lazily at execution time.
- `unbrowse auth-capture <url>` opens an interactive login and binds
  credential pointers for later replay.

## 6. Configuration
- Env loaded at startup from `.env` / `.env.runtime` (`src/cli.ts`).
- Key variables (see `src/config/`, `src/env/`):
  - URLs: `UNBROWSE_URL` (local daemon, default `http://localhost:6969`),
    `UNBROWSE_BACKEND_URL`, `UNBROWSE_FRONTEND_URL`
  - Identity: `UNBROWSE_API_KEY`, `UNBROWSE_PROFILE`, `UNBROWSE_CONFIG_DIR`
  - Wallet/payments: `UNBROWSE_WALLET_ADAPTER`, `UNBROWSE_WALLET_KEY`,
    `UNBROWSE_WALLET_SECRET`, `UNBROWSE_DISABLE_LOCAL_WALLET`,
    `UNBROWSE_X402_MAX_COST_USD` (default $1.00),
    `UNBROWSE_X402_SIGNER` (extensible signer hook), `OWS_WALLET_ADDRESS`,
    `LOBSTER_WALLET_ADDRESS`, `AGENT_WALLET_ADDRESS`,
    `FLEX_ESCROW_ADDRESS`, `FLEX_SESSION_KEY_ADDRESS`
  - Proxy/egress: `UNBROWSE_PROXY_URL`, `UNBROWSE_DIRECT_EGRESS`
  - Telemetry/tracing: `UNBROWSE_TELEMETRY`, `UNBROWSE_TRACE`,
    `UNBROWSE_TRACE_DIR`
  - Test/dev: `UNBROWSE_NON_INTERACTIVE`, `UNBROWSE_LOCAL_ONLY`,
    `UNBROWSE_MCP_V7_DISPATCH`

## 7. Client payment rails (detail)
- **x402 wrapper** `src/payments/x402-fetch.ts`: intercepts HTTP 402/407,
  reads the `accepts[]` payment-terms envelope, resolves a wallet adapter,
  enforces the per-request cost ceiling, signs, retries once, and records an
  honest outcome state (`x402_signed`, `x402_no_wallet`,
  `x402_signer_error`, `x402_cost_exceeded`, `x402_retry_blocked`,
  `x402_passthrough`). It never fabricates success.
- **Flex settlement** `src/payments/flex-pay.ts`: pays server-frozen splits
  verbatim (never recomputed client-side); signing is delegated to the
  session-key SDK; returns `{data, settled, authorization}` or throws.
- **lobster.cash bridge** `src/payments/lobster-pay.ts`: shells out to the
  `lobstercash` CLI for sign/broadcast; availability check is the presence
  of `~/.lobster/agents.json`.
- **OWS provider** `src/payments/ows.ts`: Open Wallet Standard v1.3 vault
  (`~/.ows/wallets/<uuid>.json`), CAIP-2/CAIP-10 account identifiers, and a
  declarative allow/deny/warn policy engine (`allowed_chains`,
  `expires_at`). Preferred provider when present.
- **Wallet status** `src/cli-wallet.ts`: read-only reconciliation of local
  wallet config vs the server-side agent profile (`/v1/agents/me`); warns on
  mismatch.
- **Provider chooser** `src/cli-payment-setup.ts`: pay.sh / lobster.cash /
  external Solana / Privy / skip(free tier); persisted locally and synced to
  the backend.
- **Discovery toll ledger** — the `*-toll-ledger.ts` / `*-toll-emit.ts`
  pair in `src/`: immutable first-discoverer binding per route;
  per-charge metering splits operator / discoverer / site-owner with exact
  conservation; emission is fire-and-forget and never breaks the request
  path.
