# Contributing to Unbrowse

Self-learning browser agent extension for Clawdbot. Captures API traffic from websites, generates reusable skills, and replays them with stored auth.

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

### Run with Clawdbot Gateway
```bash
clawdbot gateway restart  # picks up extension changes
clawdbot gateway status   # check if running
```

Gateway logs: `~/.clawdbot/logs/gateway.log`

## Architecture

```
index.ts                    # Plugin entry point (11 tools, hooks)
src/
├── har-parser.ts           # HAR → API endpoints
├── skill-generator.ts      # Endpoints → SKILL.md + auth.json + api.ts
├── profile-capture.ts      # Playwright-based network capture
├── session-login.ts        # Credential login + session capture
├── cdp-capture.ts          # Live CDP network capture
├── stealth-browser.ts      # Cloud browser via BrowserBase
├── auto-discover.ts        # Background skill generation hook
├── skill-index.ts          # Cloud marketplace client
├── vault.ts                # Encrypted credential storage
├── token-refresh.ts        # OAuth/JWT token refresh detection
├── dom-service.ts          # Browser-use style element indexing
└── site-crawler.ts         # Link discovery and crawling
server/                     # Skill marketplace server (x402 payments)
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

# Manual testing via Clawdbot
clawdbot gateway restart
# Then use unbrowse_* tools in a Clawdbot session
```

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `npx tsc --noEmit` to verify types
5. Submit a PR with a clear description

## License

MIT
