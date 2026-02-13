# Unbrowse Protocol Specification

> An open standard for packaging, sharing, and replaying internal web APIs.

## Overview

Unbrowse defines an open format for capturing, describing, and replaying the internal APIs that power every website. Any agent framework can produce and consume Unbrowse skills — they are plain files with a documented schema.

## Skill Package Format

A skill is a directory containing:

```
my-skill/
├── SKILL.md          # Human + machine-readable endpoint docs
├── auth.json         # Captured authentication (local only)
├── headers.json      # Request headers template
├── scripts/
│   └── api.ts        # Generated typed client (optional)
└── references/       # Example responses (optional)
```

### SKILL.md

YAML frontmatter + markdown body:

```yaml
---
name: jupiter
description: "Jupiter DEX Aggregator API — swap quotes and routing"
metadata:
  author: unbrowse
  version: "1.0"
  baseUrl: "https://quote-api.jup.ag"
  authMethod: "None"
  endpointCount: 12
  apiType: "internal"
---
```

Body contains endpoint documentation in markdown format with method, path, description, and example parameters.

### auth.json

```json
{
  "cookies": [
    { "name": "session_id", "value": "...", "domain": ".example.com" }
  ],
  "headers": {
    "authorization": "Bearer ...",
    "x-csrf-token": "..."
  },
  "capturedAt": "2026-02-12T10:00:00Z",
  "expiresEstimate": "2026-02-13T10:00:00Z"
}
```

**Auth stays local.** Publishing a skill to the marketplace strips all auth data. Consumers must authenticate independently.

### headers.json

Template headers captured from the original browser session:

```json
{
  "user-agent": "Mozilla/5.0 ...",
  "accept": "application/json",
  "accept-language": "en-US,en;q=0.9"
}
```

## Marketplace API

Base URL: `https://index.unbrowse.ai`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/skills` | List published skills |
| GET | `/api/skills/:id` | Get skill details |
| GET | `/api/skills/search?q=` | Search skills |
| POST | `/api/skills/publish` | Publish a skill (requires wallet signature) |
| GET | `/api/skills/:id/download` | Download skill package |

### Authentication

Publishing requires a Solana wallet signature (Ed25519). Reading is free and unauthenticated.

### Payments

Skills can be free or paid (USDC on Solana via x402 protocol). The marketplace takes no commission — all payments go directly to the skill creator's wallet.

## Integration Guide

Unbrowse skills are framework-agnostic. To integrate with any agent framework:

1. **Parse SKILL.md** — Extract endpoint info from frontmatter + markdown
2. **Load auth.json** — Apply cookies/headers to requests
3. **Make requests** — Standard HTTP calls with captured auth
4. **Handle auth refresh** — Re-capture when tokens expire (401/403)

### Example: Raw fetch

```javascript
import { readFileSync } from 'fs';

const auth = JSON.parse(readFileSync('auth.json', 'utf8'));
const response = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11...', {
  headers: { ...auth.headers }
});
```

### Example: With any MCP-compatible agent

Skills can be exposed as MCP tools. Each endpoint becomes a callable tool with typed parameters.

## Versioning

- Skill format version: `1.0`
- Breaking changes increment major version
- Backwards-compatible additions increment minor version

## License

This specification is released under AGPL-3.0-only. See [LICENSE](LICENSE).
