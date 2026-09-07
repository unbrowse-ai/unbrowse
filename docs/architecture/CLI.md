# CLI and local engine

The current CLI uses flat commands.

```bash
unbrowse "task" --url https://example.com
unbrowse fetch https://example.com
unbrowse resolve --intent "task" --url https://example.com --no-execute
unbrowse capture --url https://example.com --intent "task"
unbrowse auth https://example.com/login
unbrowse health
```

The one-call command resolves, executes, and reads a result. `resolve
--no-execute` is the inspection path. Browser operations use `go`, `snap`,
`click`, `submit`, and `close`.

## Local state

- `~/.unbrowse/config.json` — account key, agent id, preferences
- `~/.unbrowse/profiles/` — per-site browser profiles
- `~/.unbrowse/vault/` — encrypted local site credentials
- `~/.unbrowse/logs/` — diagnostic logs
- local route caches — reusable route metadata and freshness

`unbrowse setup` installs the Agent Skill. `--mcp` adds the optional MCP
compatibility surface.
