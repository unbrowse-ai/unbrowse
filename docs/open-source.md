# What is open source

This repository is the Unbrowse client, MIT-licensed. It started as the client-side code of the
hosted service (unbrowse6 `7e408b90`), with a CLI on top.

| Path | What | From |
|---|---|---|
| `src/client.ts` | `Unbrowse` REST client | unbrowse6 `src/lib/unbrowse/client.ts`, plus REST reads and a `resume` fix |
| `src/types.ts` | Run, requirement and harness types | unbrowse6 `src/lib/unbrowse/types.ts` |
| `src/mcp-install.ts` | Install links and commands for the hosted MCP | unbrowse6 `src/lib/unbrowse/mcp-install.ts` |
| `skill/SKILL.md` | The agent contract | unbrowse6 `skill/SKILL.md` |
| `src/cli.ts` | The `unbrowse` command | new |
| `src/auth.ts` | API key and OAuth sign-in storage | new |
| `tests/` | CLI tests against a local stand-in API | new |
| `docs/` | These docs and the [whitepaper](whitepaper/README.md) | new |

The hosted service is not here: the cloud browser, the learn loop, replay, render fallback, the
public registry, the password manager, routing, metering and billing. Everything in
[how-it-works.md](how-it-works.md) happens server-side.

## What the client sends

- REST calls to `/api/v1` with your bearer token (none for the public `/sites` routes).
- OAuth requests to `/oauth/register`, `/authorize` (in your browser) and `/oauth/token`.

It stores one file, `~/.config/unbrowse/cli.json` (0600), and sends no telemetry of its own.

## Keeping in step with the service

`client.ts`, `types.ts`, `mcp-install.ts` and `skill/SKILL.md` track the service. Changes there
go upstream first. `--base-url` targets any deployment with the same `/api/v1` contract.
