---
name: unbrowse-auto-discover
description: Auto-generates skills when the agent browses APIs
metadata:
  openclaw:
    emoji: "🔍"
    events: ["tool_result_persist"]
    export: "default"
---

# Auto-Discover Hook

Watches browser tool usage and automatically generates skills when API traffic is detected.

## How It Works

1. Listens for `tool_result_persist` events from the `browser` and `browse` tools
2. Polls captured network requests from the browser control API
3. When 5+ API calls to a new domain are detected, auto-generates a skill
4. Skills are saved to `~/.openclaw/skills/<service>/`

## Configuration

Enable/disable in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      unbrowse: {
        config: {
          autoDiscover: true  // default: true
        }
      }
    }
  }
}
```

## Generated Output

For each discovered API:
- `SKILL.md` — OpenClaw-compatible skill definition
- `auth.json` — Extracted authentication (headers, cookies)
- `scripts/api.ts` — TypeScript API client
