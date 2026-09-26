# unbrowse (client) — guide for agents

Thin CLI over the hosted Unbrowse REST API (`/api/v1`). No browser, no local MCP, no site logic.

| Path | Owns |
|---|---|
| `src/client.ts`, `src/types.ts`, `src/mcp-install.ts`, `skill/SKILL.md` | From unbrowse6 (`src/lib/unbrowse/`, `skill/`). Change upstream first |
| `src/cli.ts` | Commands, run polling, exit codes |
| `src/auth.ts` | API key and OAuth (PKCE, loopback) storage |
| `tests/cli.test.ts` | CLI against a local stand-in of the REST API |

Commands: `bun test` · `bun run typecheck` · `bun run build` · `bun src/cli.ts help`.

Rules:
- A command maps to one REST route. Add it to `docs/cli.md` and a test.
- Never accept, log or print a password or token.
- `dist/cli.js` must run on plain Node 18.17+.
- Root CLAUDE.md is a byte copy of this file.
