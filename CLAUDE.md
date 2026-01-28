# Unbrowse Extension

Self-learning browser agent extension for Clawdbot. Captures API traffic from websites, generates reusable skills, and replays them with stored auth.

## Clawdbot Gateway

The gateway runs as a macOS Launch Agent via launchd.

### Restart (picks up extension changes)
```bash
clawdbot gateway restart
```

### Other commands
```bash
clawdbot gateway stop
clawdbot gateway start
clawdbot gateway status
```

### Dev mode (no channels, foreground)
```bash
cd /Users/lekt9/Projects/aiko/clawdbot
pnpm gateway:dev
pnpm gateway:watch    # auto-restart on code changes
```

### Full rebuild + restart (Swift app + gateway)
```bash
cd /Users/lekt9/Projects/aiko/clawdbot
pnpm mac:restart      # runs scripts/restart-mac.sh
```

### Launchd details
- Plist: `~/Library/LaunchAgents/com.clawdbot.gateway.plist`
- Logs: `~/.clawdbot/logs/gateway.log` / `gateway.err.log`
- Port: 18789
- Config: `~/.clawdbot/clawdbot.json`

## Build

```bash
npx tsc          # compile TypeScript
npx tsc --noEmit # type-check only
```

## Key Architecture

- `index.ts` — Plugin entry, 11 tools, hooks
- `src/har-parser.ts` — HAR -> API endpoints (accepts seedUrl for correct naming)
- `src/skill-generator.ts` — Endpoints -> SKILL.md + auth.json + api.ts
- `src/profile-capture.ts` — Playwright-based capture (filters to XHR/Fetch only)
- `src/session-login.ts` — Credential login + session capture
- `src/cdp-capture.ts` — Live CDP network capture
- `src/stealth-browser.ts` — Cloud browser via Browser Use SDK
- `src/auto-discover.ts` — Background skill generation hook
- `src/skill-index.ts` — Cloud marketplace client
- `server/` — Bun HTTP marketplace server with x402 Solana payments

## Learnings

- `parseHar(har, seedUrl?)` — always pass seedUrl to get correct service name/baseUrl. Without it, the most-frequent domain wins (often google-analytics or tiktok).
- Profile capture filters to XHR/Fetch resource types only. GET requests returning text/html are page navigations, not API calls.
- Set-Cookie headers must NOT be split on commas — date values like "Expires=Thu, 01 Jan 2026" contain commas.
- Stealth capture via CDP `Network.enable` only catches future traffic. Must navigate via Playwright with request listeners attached first.
- Skill diff detection uses `` ^- `(GET|POST|...)` `` regex to count endpoints in SKILL.md, not `^### `.
- Output dir nested path check uses `path.basename()` to prevent `skills/name/name` duplication.
