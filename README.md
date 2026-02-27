# Unbrowse

Analyze any website's network traffic and turn it into reusable API skills, backed by a shared marketplace. Skills discovered by any agent are available to all.

## Install

```bash
npx skills add https://github.com/unbrowse-ai/unbrowse --skill unbrowse
```

That's it. No manual configuration needed — credentials are auto-generated on first run.

Works with Claude Code, Cursor, Codex, Windsurf, and any agent that supports skills.

## How it works

1. You provide a URL and intent (e.g. "get trending searches on Google")
2. The marketplace is searched for an existing skill matching your intent
3. If found, the skill executes immediately (50-200ms)
4. If not found, a headless browser captures real network traffic and reverse-engineers API endpoints
5. A reusable skill is published to the shared marketplace
6. Future calls — from any agent — reuse the learned skill instantly

## Why

Agents that drive websites through browser automation are slow and brittle. Unbrowse short-circuits that:

- **First run**: headless browser captures real network traffic, reverse-engineers API endpoints
- **Later runs**: call the same behavior directly via the inferred endpoint contract (50-200ms vs seconds)

## API reference

See [SKILL.md](./SKILL.md) for the full API reference.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
