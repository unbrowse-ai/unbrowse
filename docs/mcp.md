# MCP

Unbrowse is a remote MCP server: `https://v3.unbrowse.ai/mcp` (Streamable HTTP, protocol
2025-11-25). Sign-in is OAuth 2.1 with PKCE and dynamic client registration; your MCP client runs
it. An API key works as `Authorization: Bearer ub_live_…`.

```bash
claude mcp add --transport http unbrowse https://v3.unbrowse.ai/mcp
codex mcp add unbrowse --url https://v3.unbrowse.ai/mcp && codex mcp login unbrowse
```

```json
{ "mcpServers": { "unbrowse": { "url": "https://v3.unbrowse.ai/mcp" } } }
```

There is no local MCP server. Agents connect to the hosted one; shells and scripts use the CLI.

## Core tools

| Tool | Use |
|---|---|
| `unbrowse.discover` | Search your private space, then the public registry |
| `unbrowse.sites` | Per-site state: public or behind sign-in, kept session, last sign-in, saved login, learned tools, bot checks |
| `unbrowse.usage` | Verified calls this month, rendered runs, passthrough cost, quota left |
| `unbrowse.run` | Start a run by `capability` id or plain-language `task`; `input` keyed by the capability's inputs |
| `unbrowse.inspect` | Status, requirements, verified result, known effects, routing explanation |
| `unbrowse.resume` | `{ runId, answers: { <field>: value } }` on the same run |
| `unbrowse.cancel` | Stop new dispatches; effect receipt |
| `unbrowse.forget` | Delete your learned capability, or unpin a public one |
| `unbrowse.browse.open` / `.snapshot` / `.act` / `.finish` / `.close` | Recorded cloud browser |
| `unbrowse.learn` | Compile HAR files or traces into a `learned.*` capability |
| `unbrowse.credentials.list` / `.request` / `.status` | Password manager: masked hints, save-login links |

When three or fewer capabilities match, dedicated `unbrowse.skill.*` tools are listed with slot
schemas from the harness. Your compiled tools appear as `my__<site>__<op>`; `tools/list` with a
query adds matching public ones.

## Per-site servers

Each compiled site is its own MCP server with its tools plus `run_task`, `browse_*`, `run_status`
and `run_answer`:

```
https://v3.unbrowse.ai/api/v1/sites/<host>/mcp
```

`unbrowse site <host>` lists the site's tools.

## Sign-in elicitation

When a tool needs a login nobody saved, clients that declared URL elicitation at `initialize`
get JSON-RPC error `-32042` with `data.elicitations[0].url`: a one-time Unbrowse page where the
person saves the login. Other clients get the link in the result (`signIn.url`, or `details.url`
on an autofill error).

## Operating order

1. `unbrowse.discover` (and `unbrowse.sites` for a site you will sign in to).
2. `unbrowse.run` with a capability id or task. Pass every input you know.
3. `input_required` → `unbrowse.resume` on the same run.
4. `no_capability` → do it once with `unbrowse.browse.*`; it is learned.

The full agent contract is [skill/SKILL.md](../skill/SKILL.md).
