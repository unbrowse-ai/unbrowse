# What is open source

This repository is the Unbrowse client, MIT-licensed. Two packages: `@unbrowse/sdk`, grown from the
hosted service's own client (unbrowse6 `7e408b90`), and the `unbrowse` CLI built on it.

| Path | What | From |
|---|---|---|
| `packages/sdk/src/client.ts` | `@unbrowse/sdk`: every `/api/v1` route | unbrowse6 `src/lib/unbrowse/client.ts`, extended; `resume` and idempotency-key fixes (also sent upstream) |
| `packages/sdk/src/types.ts` | Run and requirement types the API returns | unbrowse6 `src/lib/unbrowse/types.ts`, trimmed to the public shapes |
| `packages/sdk/src/mcp-install.ts` | Install links and commands for the hosted MCP | unbrowse6 `src/lib/unbrowse/mcp-install.ts` |
| `skill/SKILL.md` | The agent contract | unbrowse6 `skill/SKILL.md`  |
| `packages/cli/src/cli.ts` | The `unbrowse` command, on the SDK | new |
| `packages/cli/src/auth.ts` | API key and OAuth sign-in storage | new |
| `packages/*/tests/` | SDK route tests, CLI tests against a local stand-in API | new |
| `docs/` | These docs and the [whitepaper](whitepaper/README.md) | new |

The hosted service is not here: the cloud browser, the learn loop, replay, render fallback, the
public registry, the password manager, routing, metering and billing. Everything in
[how-it-works.md](how-it-works.md) happens server-side.

## What the client sends

- REST calls to `/api/v1` with your bearer token (none for the public `/sites` routes).
- OAuth requests to `/oauth/register`, `/authorize` (in your browser) and `/oauth/token`.

It stores one file, `~/.config/unbrowse/cli.json` (0600), and sends no telemetry of its own.

## Keeping in step with the service

The SDK sources and `skill/SKILL.md` track the service. Changes there
go upstream first. `--base-url` targets any deployment with the same `/api/v1` contract.
