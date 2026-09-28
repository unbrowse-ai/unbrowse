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
| `discover <query>` | Your capabilities, then the public registry |
| `run <task…>`, `inspect`, `resume`, `cancel` | Runs |
| `learn a.har b.har`, `learned [id]` | Teach a site from two recordings |
| `logins`, `logins remove <origin>` | Saved logins, masked. The CLI never takes a password |
| `registry [query]`, `site <host>` | Public compiled sites, no account |

The CLI is the REST client. The remote MCP is a separate client; see the [install guide](https://github.com/unbrowse-ai/unbrowse-skill/blob/main/docs/install.md).

Exit codes: 0 accepted/ok (check status and verified), 1 error, 2 input required, 3 sign-in or saved login needed, 4 not verified.
Env: `UNBROWSE_API_KEY`, `UNBROWSE_BASE_URL`. Node 18.17+, no dependencies.

Install the hosted-client preview from the [installation guide](https://github.com/unbrowse-ai/unbrowse-skill/blob/main/docs/install.md); npm latest may be an older client.

The agent contract ships as `SKILL.md` with `references/` in this package. Full reference, docs and the whitepaper:
https://github.com/unbrowse-ai/unbrowse-skill
