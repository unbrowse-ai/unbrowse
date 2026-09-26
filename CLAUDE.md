READ ~/.claude/AGENTS.md BEFORE ANYTHING (skip if missing).

# unbrowse (client) — guide for agents

Open-source client for the hosted Unbrowse REST API (`/api/v1`). No browser, no local MCP, no site logic.

| Path | Owns |
|---|---|
| `packages/sdk` | `@unbrowse/sdk`: every `/api/v1` route. client and types maintained here; only `mcp-install.ts` is source-synced |
| `packages/cli` | `unbrowse` CLI on the SDK (bundled in). `auth.ts`: API key and OAuth storage |
| `skill/SKILL.md` | Agent contract, from unbrowse6 `skill/`; shipped in the CLI package |
| `docs/` | User docs and the whitepaper |

Commands: `bun install` · `bun test packages` · `bun run typecheck` · `bun run build` · `bun run cli help`.

Rules:
- A new API route gets an SDK method and a row in `packages/sdk/tests/client.test.ts`; a CLI command maps to one SDK method.
- Never accept, log or print a password or token.
- Built output runs on plain Node 18.17+.
- Root CLAUDE.md is a byte copy of this file.

Money gap: a new user can install the right client and complete a first hosted request.

Root CLAUDE.md and AGENTS.md must be identical. No nested agent instruction files.

Public boundary: [docs/public-sync.md](docs/public-sync.md). Verify with `bun run check:public` (PUBLIC_SURFACE_OK), then tests and packed-client smoke. Read package MODULE.md before editing.
