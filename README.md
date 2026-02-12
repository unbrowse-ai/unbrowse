# Unbrowse

**The open protocol for agent web access.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@getfoundry/unbrowse-openclaw)](https://www.npmjs.com/package/@getfoundry/unbrowse-openclaw)

Every website has internal APIs — the hidden endpoints their frontend calls. Unbrowse captures them, packages them as reusable skills, and lets any AI agent call them directly. No browser automation. No Playwright. No Puppeteer.

Think of it as **DNS for the agent internet** — mapping websites to callable APIs.

## Why

Browser automation is slow, fragile, and detectable. Every major site blocks it. But their internal APIs work perfectly — because that's what their own frontend uses.

Unbrowse flips the approach: instead of automating browsers, reverse-engineer the APIs they already have.

## How It Works

```
1. Capture    →  Visit any site, intercept all API traffic
2. Package    →  Generate a skill (endpoints + auth + docs)
3. Replay     →  Call internal APIs directly, 100x faster than browser
4. Share      →  Publish to the open marketplace for other agents
```

## Quick Start

```bash
# Install as OpenClaw extension
openclaw plugins install @getfoundry/unbrowse-openclaw

# Or use standalone
npm install @getfoundry/unbrowse-openclaw
```

## Core Tools

| Tool | Description |
|------|-------------|
| `unbrowse_capture` | Visit URLs, capture internal API traffic, generate a skill |
| `unbrowse_learn` | Parse a HAR file into a skill package |
| `unbrowse_login` | Authenticate on a site, save session for replay |
| `unbrowse_replay` | Call captured endpoints with stored auth |
| `unbrowse_publish` | Share a skill to the open marketplace |
| `unbrowse_search` | Find and install community skills |
| `unbrowse_wallet` | Solana wallet for marketplace payments |

## Marketplace

The Unbrowse marketplace is an open skill registry where agents share reverse-engineered APIs.

- **Free to search and browse** — no auth required
- **USDC payments on Solana** via x402 protocol for paid skills
- **Creators earn directly** — no platform commission
- **35+ skills live** — Jupiter, Polymarket, TikTok, Airbnb, Reddit, and more

Index: [index.unbrowse.ai](https://index.unbrowse.ai)

## Open Protocol

Unbrowse defines an open, framework-agnostic standard for packaging web APIs. Any agent framework can produce and consume Unbrowse skills — they're just files.

See [PROTOCOL.md](PROTOCOL.md) for the full specification.

## Security

- **All data stays local** — captured auth never leaves your machine unless you explicitly publish
- **Auth is stripped on publish** — marketplace skills contain endpoint docs only, no credentials
- **Open source** — audit everything

See [SECURITY.md](SECURITY.md) for the full trust model.

## Contributing

Unbrowse is a public good for the agent ecosystem. Contributions welcome.

See [GOVERNANCE.md](GOVERNANCE.md) for contribution guidelines and [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Capture    │────▶│  Skill Pkg   │────▶│   Marketplace   │
│  (browser)   │     │  (local fs)  │     │  (Solana/USDC)  │
└─────────────┘     └──────────────┘     └─────────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │    Replay    │
                    │ (direct API) │
                    └──────────────┘
```

## License

Apache 2.0 — See [LICENSE](LICENSE)
