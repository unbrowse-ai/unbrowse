# Unbrowse for Claude Code

A Claude Code plugin that connects Claude to the Unbrowse node on your machine. It brings:

- the node's MCP server, through `unbrowse mcp`: every agent tool the node serves (`unbrowse_do`, `unbrowse_browse`,
  `unbrowse_search`, `unbrowse_call`, `unbrowse_logins`, `unbrowse_judge`, `unbrowse_report` and the rest, as
  [CLI.md §5](../../docs/CLI.md#5-the-agent-api-and-mcp-tools) lists them)
- a hooks module ([`hooks/register.tsx`](hooks/register.tsx)) that makes the node part of Claude Code: `WebFetch`
  goes to the node first, every node answer carries a receipt (cost, and the tokens Claude did not read), running
  totals and the node's balance with its Add funds link sit above the prompt, the node's routes become tools, and
  `/unb` opens a pane with the balance, the ledger, the routes,
  the node's live activity and the sites Claude wanted (all below)
- the skill [`unbrowse`](../../skills/unbrowse/SKILL.md), linked from the repository's `skills/` so there is one copy
  (`unbrowse-map` isn't included: it works only from a checkout of this repository)

It needs a running node ([docs/start/install.md](../../docs/start/install.md)) and the `unbrowse` command on PATH
(`npm install -g unbrowse`): the plugin starts `unbrowse mcp`, which relays Claude's MCP messages to the node, each signed
with the agent token: the token never goes over the wire, and an answer reaches Claude only when the node signed it, so a
process that took or relays the node's port keeps nothing it can use. Claude Code never sends the token itself. The node needs no account and no
sign-in: it joins the network with its own wallet (spec §86), and linking a wallet of yours is optional, only for
cashing out ([ONBOARDING.md](../../docs/ONBOARDING.md#2-linking-a-wallet-optional)).

## Install

```
/plugin marketplace add unbrowse-ai/unbrowse
/plugin install unbrowse@unbrowse
```

Claude Code asks for these values when the plugin is enabled:

| Value | What to give |
|---|---|
| Agent | Which agent key Claude uses: `first` (the default, the key the node made on its first run) or a key's number (`unbrowse agent new <name>` prints it; the window shows it under Money, Agents). Let it in once with `unbrowse grant first` (or `unbrowse grant <number>`): the node asks you, and `unbrowse mcp` reads that grant as it starts. No token is asked for here or kept in any config |
| Node address | Where the node listens. Defaults to `http://127.0.0.1:7788` |
| WebFetch | `routes` (the default) answers Claude's `WebFetch` from the node's routes when it has one; `off` leaves `WebFetch` alone |
| Tokens saved | `measure` (the default) fetches the page a node answer stood for once, to count the tokens Claude did not read; `off` doesn't |
| Route tools | `on` (the default) makes each local read route a tool, and names the sites in the system prompt; `off` doesn't |
| Heal routes | `on` learns a failed route afresh in the background; `off` (the default) leaves it to Claude |

Change them later in `/config`, or with `/plugin` on the plugin's page.

To try it from a checkout without installing: `claude --plugin-dir ./integrations/claude-code`.

### Or without the plugin

`npm install -g unbrowse && unbrowse connect` does the same in two parts: `connect` starts the node if it isn't
running and adds its MCP server for the agent the node made (`claude mcp add --scope user … unbrowse …/mcp`), and the
npm install puts the skill in `~/.claude/skills/unbrowse`. Use one route, not both: with the server added by
`connect` (or `claude mcp add … unbrowse`) and the skill in `~/.claude/skills/unbrowse`, the plugin makes Claude see
each tool and the skill twice. `claude mcp remove unbrowse --scope user` and removing `~/.claude/skills/unbrowse`
undo the other route.

## Use

Ask for something a website does, with the page that does it:

```
search Carousell Singapore for 2x32GB DDR4 SODIMM kits: https://www.carousell.sg/search/sodimm%20ddr4%2064gb
```

Claude calls `unbrowse_do`. The node calls the route that does it, or learns one from the page and calls that. When the
page needs clicks or typing, Claude drives the node's browser with `unbrowse_browse`, and the node learns a route from
those steps. The skill covers the rest: logins and cards from the vault, pages only the owner can get past
(`ask_owner`), judging a wrong answer, and failed writes.

Another contributor's route costs its fee, which the node pays by itself from its balance, up to the owner's per-fetch
maximum; nothing waits for you. Add funds in the window (Money, Add funds) for that
([MONEY.md](../../docs/MONEY.md)).

A call can take minutes when the node walks a page, so the server's tool timeout is 330 seconds, the same as the SDKs.

## WebFetch goes to the node first

When Claude fetches a page with `WebFetch`, the plugin asks the node first, through `unbrowse_do` with the page as `url`
and Claude's prompt as `goal`, `browser: "never"` and `budget_usdc: 0`. The node answers only from a route it already
has, a route another contributor lists for free, or a plain request: it opens no browser and pays nothing. When that
answer holds the site's data, Claude reads it as the fetch's result, as JSON from the site's own API with the route it
came from; otherwise, or when the node takes longer than 15 seconds, `WebFetch` fetches the page as it always does.
Continuing a long page (`offset`) always goes to `WebFetch`. Set the plugin's WebFetch value to `off` to switch it off.

Claude can still ask the node for anything with `unbrowse_do`, including a page it has to learn or a route that
costs a fee.

## Receipts, payments and tokens saved

Under each node answer (a `WebFetch` the node answered, Claude's own `unbrowse_do`, a route tool) the plugin draws one
line from the node's reply: how it went (`called`, `network`, `learned`, `browse`), the site, the route, the call's
own time as the node measured it, whether the browser was used, what was paid, and the tokens Claude did not read:

```
⏺ WebFetch(https://hn.algolia.com/?q=rust)
  ⎿  Received 1.2KB (200 OK)
     Unbrowse called · hn.algolia.com · hn-search · 84 ms · no browser · free · ≈96k tokens saved · in place of WebFetch
```

It sits under the row's own result line, dim, the way Claude Code draws a result's second line.

Tokens saved is the page against the answer that stood for it, at about four characters a token: the plugin
fetches the page once after the answer (cached per address for the session) and counts its characters. It's a
measure of what reading the page would have cost, not of what any one tool would have sent Claude. Set Tokens saved
to `off` to skip the fetch; the figure is then left out.

Above the prompt, the node's balance with a link to add funds, this session's totals, and the node's route count:

```
Unbrowse $2.99715 · Add funds · 12 calls · 11 no browser · paid $0.004 · ≈248k tokens saved · 286 routes
```

The balance is what `unbrowse-node money` prints (USDC on Arc, as the window's balance badge shows it; `test` after it
on a test network), read when the session starts, once a minute, after a paid answer and when `/unb` opens. **Add
funds** is a link to the node's own top-up page (`{site}/fund/#node=…`), the one the window's badge opens. The `money`
command reads the owner's token itself; the plugin only reads what it prints. A node that can't start yet says how
much to add (`add $1.90 to start`), in the theme's warning colour. With no node, or a CLI that has no `money`, the
balance is left out.

Everything the plugin draws uses the host's theme colours (`text`, `success`, `warning`, `suggestion`, dim), never
fixed hex, so it reads the same as Claude Code's own rows in light, dark and every `/theme`.

`/unb` opens a pane with the balance and Add funds, the ledger for this session and all time (kept in the plugin's
store), the node's routes by
site, the node's live activity read from its own log (`~/.unbrowse/activity.jsonl`, every agent's learns and calls),
and the sites Claude fetched that had no route yet, most wanted first. That list stays on this machine.

## Routes as tools

At the start of a session the plugin lists the node's local routes (`unbrowse_search` with an empty query) and makes
each read route a tool: `route_<site>_<what>`, its inputs the route's own (secret inputs left out), each optional
with the value the route was learned with. They are deferred tools, so Claude sees their names and loads one with
ToolSearch when it needs it. A call runs `unbrowse_call` with the route's id. Write routes and other contributors'
routes are left out: those stay with `unbrowse_do` and `unbrowse_call`, where the node asks for what it must.

A short section of the system prompt names the sites the node has routes for, so Claude reaches for a route before
`WebFetch` or a browser.

## Watches: a webhook for any site

Ask Claude to watch something ("tell me when a new listing for 2x32GB SODIMM shows up", "wake me when the model's
downloads pass a million") and it sets a watch with the plugin's `watch` tool. A watch replays one of the node's
routes on a timer (the site's own API, warm HTTP, no browser) and fires when the answer changes the way it says:

| `when` | Fires when |
|---|---|
| `{"kind":"changed","path"?}` | the answer, or the value at `path`, changed |
| `{"kind":"threshold","path","op","value"}` | the value at `path` becomes `>`, `<`, `>=`, `<=`, `==`, `!=` or `contains` the value (once as it becomes true, not on every check while it stays true) |
| `{"kind":"new_items","path","key"?}` | the list at `path` gained items (`key` names the field that tells them apart) |

Paths read the route's data: `hits`, `items[0].price`, `stats.downloads`. The first check is the baseline and never
fires. Then it does any of:

| `then` | What happens |
|---|---|
| `toast` (the default) | a toast in the open session |
| `wake` | a Claude turn starts in that session with what changed and the person's `note` ("summarise the new story") |
| `suggest` | the same text is put in the prompt box, to send or not |
| `agent` | a background agent is given it |
| `phone` | a message through the daemon hub's `notify_send`, where one is connected |

A watch takes a route id (from `unbrowse_search`, or a `route_<site>_<what>` tool's name) with its inputs, or a `url`
and `goal` for the node to learn first. `every` is `5m` by default, at least a minute. `watches` lists them, with how
often each fired; `unwatch` stops one; the `/unb` pane shows them and the last fires, and the band says how many are
watching and what fired in the last quarter hour.

Claude offers a watch on its own when it should: a short section of the system prompt tells it to offer one when
you ask to be told when something changes, wait on a price, stock, listing, release or status, or keep checking the
same page, and to set it only once you say yes. And when you call the same route a second time in a session, the
plugin puts `Watch <what> on <site> for me and tell me when it changes` in the prompt box, once, to send or ignore.

Watches are kept in the plugin's store, so every session sees the same ones. They're checked while a Claude Code
session is open, by one session at a time (a lease the checking session renews), and wait while none is. A check is
one `unbrowse_call` of a route on this node, which pays nothing.

## Pages that need hands, and failed routes

When the node says a page needs clicks or typing (`how: browse`), a toast says so with the node's reason. When a
route fails and Heal routes is `on`, the node learns the page afresh in the background with its browser allowed and
nothing paid, and a toast says whether it works again.

## Files

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | The manifest, and the two values Claude Code asks for |
| `.mcp.json` | The node's MCP server: `unbrowse mcp`, given the node address and the agent token in its environment |
| `skills/unbrowse` | A link to `skills/unbrowse` at the repository root |
| `hooks/watch.ts` | Watches: reading a route's answer and deciding to fire |
| `hooks/hooks.json`, `hooks/register.tsx` | The hooks module: WebFetch through the node, receipts, the ledger, the balance, route tools, the `/unb` pane |
| `types/index.d.ts` | The module's state contract: receipts, ledgers, activity, routes, sites wanted, the balance |
| `.claude-plugin/icon.png` | The plugin's icon in `/plugin` and the marketplace: the app's own (`unbrowse-node/app/icons/icon.png`) |
| `tests/` | `claude plugin test ./integrations/claude-code` runs them |

The marketplace is [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) at the repository root.
Installed from git, Claude Code copies the linked skill into the plugin's cache. Check a change with
`claude plugin validate ./integrations/claude-code`, `claude plugin test ./integrations/claude-code` and
`claude plugin validate .`; CI checks the manifests and the
link with `python3 integrations/check.py`.

Docs: [plugin manifest](https://code.claude.com/docs/en/plugins-reference),
[marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
[symlinks in a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace.md),
[MCP servers](https://code.claude.com/docs/en/mcp.md).

## Licence

[Apache-2.0](../../LICENSE).
