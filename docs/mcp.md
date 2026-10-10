# MCP

Unbrowse is a remote MCP server: `https://unbrowse.ai/mcp` (Streamable HTTP, protocol
2025-11-25). Sign-in is OAuth 2.1 with PKCE and dynamic client registration; your MCP client runs
it. An API key works as `Authorization: Bearer ub_live_…`.

```bash
claude mcp add --transport http unbrowse https://unbrowse.ai/mcp
codex mcp add unbrowse --url https://unbrowse.ai/mcp && codex mcp login unbrowse
```

```json
{ "mcpServers": { "unbrowse": { "url": "https://unbrowse.ai/mcp" } } }
```

Agents connect to the hosted server. For hosts that need a local stdio server, or reject tool names with dots (Grok Build), `npx -y unbrowse mcp` proxies to it with the CLI's sign-in; tool names there use `_` (`unbrowse_scrape`). See [cli.md](cli.md#local-mcp-proxy). Shells and scripts use the CLI.

Install the [agent skill](install.md#agent-skill) for operating guidance. Exported core input schemas: [tools.json](../skill/references/tools.json). The connected server's `tools/list` also includes user-specific tools.

## Core tools

| Tool | Use |
|---|---|
| `unbrowse_discover` | Search your private space, then the public registry |
| `unbrowse_sites` | Per-site state: public or behind sign-in, kept session, last sign-in, saved login, learned tools, bot checks |
| `unbrowse_usage` | Verified calls this month, rendered runs, passthrough cost, quota left |
| `unbrowse_run` | Start a run by `capability` id or plain-language `task`; `input` keyed by the capability's inputs |
| `unbrowse_inspect` | Status, requirements, verified result, known effects, routing explanation |
| `unbrowse_resume` | `{ runId, answers: { <field>: value } }` on the same run |
| `unbrowse_cancel` | Stop new dispatches; effect receipt |
| `unbrowse_forget` | Delete your learned capability, or unpin a public one |
| `unbrowse_browse_open` / `_snapshot` / `_act` / `_finish` / `_close` | Recorded cloud browser |
| `unbrowse_learn` | Compile HAR files or traces into a `learned.*` capability |
| `unbrowse_credentials_list` / `_request` / `_status` | Password manager: masked hints, save-login links |

When three or fewer capabilities match, dedicated `unbrowse_skill_*` tools are listed with slot
schemas from the harness. Your compiled tools appear as `my__<site>__<op>`; `tools/list` with a
query adds matching public ones.

## Per-site servers

Each compiled site is its own MCP server with its tools plus `run_task`, `browse_*`, `run_status`
and `run_answer`:

```
https://unbrowse.ai/api/v1/sites/<host>/mcp
```

`unbrowse site <host>` lists the site's tools.

## Sign-in elicitation

When a tool needs a login nobody saved, clients that declared URL elicitation at `initialize`
get JSON-RPC error `-32042` with `data.elicitations[0].url`: a one-time Unbrowse page where the
person saves the login. Other clients get the link in the result (`signIn.url`, or `details.url`
on an autofill error).

## Operating order

1. `unbrowse_discover` (and `unbrowse_sites` for a site you will sign in to).
2. `unbrowse_run` with a capability id or task. Pass every input you know.
3. `input_required` → `unbrowse_resume` on the same run.
4. `no_capability` → do it once with `unbrowse_browse_*`; it is learned.

The full agent contract is [skill/SKILL.md](../skill/SKILL.md).

## Live canvas

When listed, `unbrowse_canvas_read` and `_put` read or create notes, plans, results and reply drafts on [your canvas](https://unbrowse.ai/app/canvas). Use the same account in both places. Card creation does not send external messages. Updates use revisions and preserve human edits.

`unbrowse_scrape` reads a page; `unbrowse_map` discovers same-site URLs. Consult the returned schemas for supported options.
