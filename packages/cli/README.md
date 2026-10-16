# unbrowse

Call websites as APIs from a shell. A thin CLI over the Unbrowse REST API
(`https://unbrowse.ai/api/v1`), built on [`@unbrowse/sdk`](https://www.npmjs.com/package/@unbrowse/sdk).

```bash
unbrowse login                               # browser sign-in, or: login --key ub_live_… (first use of any command does this too)
unbrowse run "top stories on Hacker News"    # site requests go from your IP; --from-unbrowse to send them from Unbrowse
unbrowse discover "flight search"             # choose a returned capability
unbrowse resume <runId> origin=SIN           # answer on the same run
```

| Command | Does |
|---|---|
| `login [--key K]`, `logout`, `whoami`, `usage` | Account |
| `accounts`, `accounts use <name>`, `--account NAME` | Several Unbrowse accounts on one machine, each with its own vault ([docs](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/cli.md#several-accounts)) |
| `discover <query>` | Your capabilities, then the public registry |
| `run <task…>`, `inspect`, `resume`, `cancel` | Runs |
| `scrape <url>` | One page as markdown on stdout |
| `index <url>`, `index status [jobId]` | Teach a site: an agent explores it and compiles each flow into a tool |
| `learn a.har b.har`, `learned [id]` | Teach a site from two recordings |
| `logins`, `logins remove <origin>` | Saved logins, masked. The CLI never takes a password |
| `registry [query]`, `site <host>`, `openapi <host>` | Public compiled sites, a site's tools, its OpenAPI 3.1 document — no account |
| `call <host> <tool> [JSON]` | Run one site tool (`--set k=v`, `--deadline MS`, `--select a,b`, `--idempotency-key K`, `--end-user ID`) |
| `browse open <url>`, `browse act <id> click e1`, `browse snapshot`, `browse finish`, `browse close` | The recorded cloud browser |
| `map <url>`, `sites [site]`, `forget <capability>`, `connect [app]`, `credits` | Site map, what your workspace knows per site, learned tools, app connections, credits |
| `credentials list`, `credentials request <origin>`, `credentials status <id>` | Saved logins, and a link for the person to save one you need |
| `replay list`, `replay search`, `replay get`, `replay timeline`, `replay ask` | Recorded sessions |
| `tools [query]`, `tool <name> [--key value…]` | Any tool by name, such as your learned site tools |

The CLI matches the remote MCP: every MCP tool has a command ([table](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/cli.md#same-as-the-mcp)). To give an agent host the MCP itself, see the [install guide](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/install.md).

Exit codes: 0 accepted/ok (check status and verified), 1 error, 2 input required, 3 sign-in or saved login needed, 4 not verified.
Env: `UNBROWSE_API_KEY`, `UNBROWSE_BASE_URL`. Node 18.17+, no dependencies.

Install: `npx unbrowse login` (OAuth in your browser), then any command. Guide: [installation guide](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/install.md).

The agent contract ships as `SKILL.md` with `references/` in this package. Full reference, docs and the whitepaper:
https://github.com/unbrowse-ai/unbrowse
