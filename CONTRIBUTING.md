# Contributing to Unbrowse

Self-learning browser agent extension for OpenClaw (also compatible with Clawdbot/Moltbot). Captures API traffic from websites, generates reusable skills, and replays them with stored auth.

## Development Setup

### Prerequisites
- Node.js 18+ or Bun
- Playwright (`npx playwright install chromium`)

### Install
```bash
npm install
# or
bun install
```

### Build
```bash
npx tsc          # compile TypeScript
npx tsc --noEmit # type-check only
```

### Run with OpenClaw Gateway
```bash
openclaw gateway restart  # picks up extension changes
openclaw gateway status   # check if running
```

Gateway logs: `~/.openclaw/logs/gateway.log`

## Architecture

```
index.ts                    # Plugin entry point (exports the plugin)
src/
├── plugin/                 # Plugin composition + tool implementations (main editing surface)
├── har-parser.ts           # HAR → API endpoints
├── skill-generator.ts      # Endpoints → SKILL.md + auth.json + scripts/*
├── cdp-capture.ts          # Live CDP network capture
├── session-login.ts        # Credential login + session capture
├── token-refresh.ts        # OAuth/JWT token refresh detection
├── skill-index.ts          # Marketplace client (x402 payments)
└── wallet/                 # Wallet persistence + unbrowse_wallet tool
server/web/                 # Marketing site (Vercel build)
test/e2e/                   # Real-backend E2E (reverse-engineer via docker compose)
test/oct/                   # Black-box gateway E2E (OCT)
third_party/openclaw-test-suite/  # Vendored OCT harness
```

## Key Concepts

### Skills
A "skill" is a learned API integration:
- `SKILL.md` — Human-readable endpoint documentation
- `auth.json` — Stored credentials (headers, cookies, tokens)
- `scripts/api.ts` — Generated TypeScript client

### Browser Connection Cascade
1. CDP connect to Clawdbot managed browser (port 18791)
2. CDP connect to Chrome remote debugging (port 9222)
3. Launch fresh Playwright Chromium

### Auth Methods
- Cookie-based (session cookies from browser)
- Header-based (Bearer tokens, API keys)
- OAuth/JWT with automatic refresh detection

## Important Notes

- `parseHar(har, seedUrl)` — Always pass seedUrl to get correct service name
- Profile capture filters to XHR/Fetch only — GET text/html are page navs
- Set-Cookie headers must NOT be split on commas (dates contain commas)
- Gateway loads `.ts` source directly — `dist/` alone is not enough

## Testing

```bash
# Type check
npx tsc --noEmit

# Unit tests
bun run test

# Integration tests (real backend, no mocks)
bun run test:e2e

# Black-box gateway tests
bun run test:oct
bun run test:oct:docker
```

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `npx tsc --noEmit` to verify types
5. Submit a PR with a clear description

## License

MIT
