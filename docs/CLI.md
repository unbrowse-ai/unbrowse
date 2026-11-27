# Commands and interfaces

Every way to tell the node something: the `unbrowse-node` commands, the owner commands the windows and the SDK send,
the agent API and its MCP tools, `unb`, the environment variables and the build flags. Written for owners scripting a
node and engineers adding a command. Each line is read from the code it names; [§9](#9-how-this-list-was-made) says
how the list was checked against it.

The programs: `unbrowse-node` is the node (`unbrowse-node/app/src/main.rs`); `unb` is the agents' shell client
(`app/src/bin/unb.rs`); `unbrowse`, which npm and PyPI install, opens the window and passes everything else on to
those two (`unbrowse-sdk/typescript/src/cli.ts`).

- [1. Running the node](#1-running-the-node)
- [2. `unbrowse-node` commands](#2-unbrowse-node-commands)
- [3. `unbrowse`, the installed command](#3-unbrowse-the-installed-command)
- [4. `unb`, the agents' shell client](#4-unb-the-agents-shell-client)
- [5. The agent API and MCP tools](#5-the-agent-api-and-mcp-tools)
- [6. Owner commands](#6-owner-commands)
- [7. Environment variables](#7-environment-variables)
- [8. Build flags](#8-build-flags)
- [9. How this list was made](#9-how-this-list-was-made)

---

## 1. Running the node

`unbrowse-node` with no command starts the node: it runs a newer release unpacked under `~/.unbrowse/versions` instead
if there is one, says on stderr whether passkeys, sharing, telemetry and bug reports are on, starts the chain, joins the peer
network once its key is unlocked and its owner has acknowledged the terms (`terms::standing`), runs the background pass once a minute, and serves the agent and owner APIs on
`127.0.0.1:<api_port>` (7788 by default, Settings). It keeps everything under `~/.unbrowse` (`UNBROWSE_HOME` moves
it). It prints, among its log lines:

```
unbrowse-node: agents and the window reach this node at 127.0.0.1:7788
```

To restart it, `unbrowse restart` (below). It answers `GET /v1/health` meanwhile (§5).

Every command below except the node itself runs and exits. Those that change a setting write
`~/.unbrowse/settings.json`; a running node reads most settings again on every pass, and the command says when one
takes effect only at the next start. Those marked **running node** send an owner command (§6) to the node over
`/owner/<cmd>` with the token in `~/.unbrowse/owner.token` (`main.rs` `owner_call`), and say "start the node first"
when it isn't running.

Exit codes: 0 done, 1 failed (the reason on stderr), 2 a usage error (the usage line on stderr). A first word the node
doesn't know is not a usage error: `main()` falls through to starting the node, so a typo, or `agent` without `new`,
starts a node rather than printing usage. Within a command, a subcommand it doesn't know prints the usage line.

### What the node asks of a site, and the switches that bring the old asks back

Since 15 November the node asks a site nothing nobody asked for: browsing is the only fallback. Since 16 November a
route learned from one sighting answers its first new value by its own call, the agent's own ask: its answer, read
whole, is served when it stands by the readers a confirming browse holds it to (it lists something, it is not the
first sighting's answer again, it says the value back by its records, or for a value that names a thing its record
is not the first one's: `learn::confirm::by_its_call`), and that call is the route's second sighting. Only an answer
in doubt is served by the browser, a walk of the agent's own page with the route called once beside it and compared
(`learn/confirm.rs`); a route that is its own page's data (a JSON or a feed address) is never walked for it: its doubt
is said and the page learned again by a plain request. The learner writes routes by
example from those walks (`UNBROWSE_LEARN_BY_EXAMPLE`) and a call runs the body it was learned as
(`UNBROWSE_FILL_BODY`). The A/B behind this is in REBUILD §12. The old behaviour is kept for one release, behind one
scheme (`app/src/learn/own_asks.rs`):

| Family (log name) | What it asks | Default | Back on |
|---|---|---|---|
| `second-look` | a second walk of a just-learned page behind the reply | held | `UNBROWSE_OWN_ASKS=second-look` |
| `nonsense` | a made-up value sent to see whether a call hears its caller | held | `…=nonsense` |
| `shrink` | leave-one-out asks for the least of a chain the site still answers | held | `…=shrink` |
| `try` | the page's controls tried in a browser behind a route | held | `…=try` |
| `paging` | a next page asked to learn how a route reads on | held | `…=paging` |
| `recheck` | the route asked its own value again at call time | held | `…=recheck` |
| `heal` | a failed call's own refetch, sign-in or re-walk | held | `…=heal` |
| `again` | an empty read sent again at once | held | `…=again` |
| `page-values` | the page's other values sent to a route learned without a browser | held | `…=page-values` |
| `rewalk` | the page walked once more when the agent's walk ended before the page asked for anything | **runs** | — |
| `setups` | the owner's own choice on a site (a store, a region, a sign-in) made again where the site asks it again | **runs** | — |

`rewalk` and `setups` run because they serve the agent's own request: a walk that ended before the page asked for
its data has not answered the agent yet, and a choice the owner made is the owner's answer to the site's question, not
a probe. The rule is "nothing nobody asked for", not "never twice". When they run, the node's log says
`   [own-ask] for the agent's request: <family> at <function>`, so the x-ray and the harness do not count them as the
node's own; a held ask says `   [own-ask] held: <family> at <function>`.

- `UNBROWSE_OWN_ASKS=<family>,<family>` asks those families again; `all` asks every one.
- `UNBROWSE_NO_<FAMILY>=0` asks one family again; `=1` holds it whatever else is set (the A/B's names, kept).
- `UNBROWSE_CONFIRM_BY_USE=0` serves a route of one sighting by its call, with no confirming browse.
- `UNBROWSE_CONFIRM_BY_BROWSE=1` is the first new value as it was from 15 November: the browser serves it, the route
  called beside it, before the route's own call is served for it (kept for one release).
- `UNBROWSE_ARM_A=1` is the old node whole: every family asked, no confirming browse. The scratch node's `ARM_A=1`
  and `ARM_B=1`, and the matrix's `MATRIX_ARM=a|b`, run the two arms of the A/B.
- `UNBROWSE_LEARN_BY_EXAMPLE=0` learns by the classifier alone; `UNBROWSE_FILL_BODY=0` builds a call's request the
  old way.

### The runtime a page's code runs in: one the sandbox's probe confines

A route at rung 2 (a function cut from the site's script, a decoder of its answer, a stored value a program reads),
and a digest at rung 1 made over a constant of the page's script, run the page's code in the node's sandbox. The
sandbox runs that code only in a runtime its probe shows confined (`sandbox::confined`; `SIGNING_PROGRAM` names one,
else `node` on the path): the probe tries reading, writing, starting a process, a worker and connecting, for real,
under all the layers together and under each alone (the runtime's permission model, and the operating system's
sandbox: `sandbox-exec` on macOS, landlock with a seccomp filter on Linux), and every layer must deny by itself. A
platform with no operating-system layer (Windows) runs no page code. No Node version is checked: measured on this
Mac on 17 November, Node 22.23.3 and Node 26.13.1 are both confined (every layer held; under Node 22's permission
model alone the network and Unix sockets were allowed, which the node does not rely on that layer for: the
operating system's layer denies them). Where no runtime is confined, no page's code is run at all: the learn says why
(`sandbox::Unheld`: no runtime; a runtime that lacks what its own layer needs, by the capability missing; or the layer
that did not hold, as the probe said it), such a route's call falls to the browser or fails, and no answer is made up.
The bank's `scratch-node.sh` still refuses a Node below 25 on its own check.

---

## 2. `unbrowse-node` commands

### agent

| Command | What it does and prints |
|---|---|
| `agent new <name> [cap] [days]` | Makes an agent key derived from the root key, with a spending cap per epoch in USDC (default 5, `agent.key_cap`) and an expiry in days (default 30), and authorises it to pay on the chain (`authorizeAgent`, `chain::authorize`). Prints the key's setup, which names the agent by its number and never holds its token: the `claude mcp add … -- unb mcp --agent <n>` line, and `export UNBROWSE_AGENT_TOKEN="$(unbrowse-node agent token <n>)"`, which reads the token from the keystore as the line runs. If authorising fails it says the key works for free routes. The window's "New agent key" starts at 5 an epoch too |
| `agent bearer [on \| off]` | Whether the node takes a token sent as a plain `Authorization: Bearer` header, from a client that doesn't sign its requests. Off on every node, new or upgraded; turning it on asks the owner first. A client refused for sending one hears what to do instead (`unbrowse connect`, `unb mcp`, the SDK or `unb`) |
| `agent token [index]` | Prints the token of a live agent key, alone on its line: `index`, else the key the node made itself. While the root key is in the OS keystore, the first time for each agent asks the owner in the node's dialog, naming the agent; the yes is kept as that agent's grant (`~/.unbrowse/bridges/agent-<n>.token`, owner-only), which `unb mcp --agent` reads and this prints from then on, until the key is revoked. Each agent is asked about apart, the node's first key too. With the root key in a plain file nothing is asked (this user's programs read that file already). Exits 3 while the node hasn't made its first key yet |
| `agent cap <index> <usdc>` | Under Advanced: what an agent key may spend an epoch, above 0 (`agent_set_cap`). The key the node makes for itself starts at 5; the node keeps the owner's cap at every renewal and grants it on the chain at once. Needs the node running |

### chain

| Command | What it does and prints |
|---|---|
| `chain` | The chain the node runs on and why (`UNBROWSE_CHAIN` or the setting), its chain ID and RPC, and the deployment from its network file: Settlement, USDC, UNB, pool and block, or that Settlement isn't deployed. Reads no chain |
| `chain devnet` \| `chain arc-testnet` \| `chain arc-mainnet` | Sets the chain from the next start. Warns when `UNBROWSE_CHAIN` in this shell names another |
| `chain deploy [--pool <usdc> <unb>]` | On a live chain only: deploys the domain proofs, the four route-coin contracts and Settlement, and the tokens and pool the network file doesn't name, signed and paid by the node's key (`chain::deploy_shared`), and writes the network file. Nothing is left to name at deployment: every number is the spec's. `--pool` seeds a stand-in pool with that much of each token; a deploy that would stand one up beside a network's own token without it is refused ([OPERATIONS.md](OPERATIONS.md)) |

### bounty

Bounties (spec ch. 8, `CoinBounties.sol`): a limit order in UNB for a site's routes. The poster releases it by
confirming an entry of the site after its own paid call on that entry passed and was claimed; after the deadline, use
of the site by others releases a bounded part, and the rest is the poster's to take back. Every command is **running
node**: it sends a `bounty_*` owner command (§6), and the node signs with its own key, paying the gas.

| Command | What it does and prints |
|---|---|
| `bounty post <site> <amount> [--limit <unb>] [--days <n>]` | Posts `amount` UNB from the node's wallet for `site` (`example.com`), approving the bounties for exactly that amount first (`bounty_post`). `--limit` is the most it pays a coin, fees and tax included (none: buys at market); open 30 days unless `--days` names another. Never sent twice while one may still land |
| `bounty confirm <bounty id> <entry>` | Confirms one of the owner's bounties for an entry of its site (`bounty_confirm`): it buys the entry's coin within the limit, paying at most the curve's quote with 1% slippage, read when the confirmation was allowed and never raised for a retry, or, with no cap kept (the bounty steps off, or allowed before the coin traded), the quote when it is sent, with the same slippage (price moved: wait, or post the bounty again with a limit), half staked for the entry's contributor and half for the owner. Refused, with nothing spent, until the owner's own paid call on that entry passed and was claimed since posting, for an entry whose coin isn't launched yet (a bounty never launches one), and while the coin is in its snipe window. A lister has to launch by the bounty's deadline (and its snipe window pass before it) for a confirmation, and by the deadline to get a share by use. |
| `bounty settle <bounty id>` | After the deadline, fixes what use by others released (`bounty_settle`): at most 5% of the USDC their counting lines paid while it was open, never more than the bounty. Anyone may |
| `bounty release <bounty id> <entry>` | Releases an entry's share of a settled bounty by use (`bounty_release`): buys the entry's coin within the limit, in proportion to the USDC its lines paid, and only while the coin's price is steady; refused otherwise, to send again later. What the limit doesn't fill stays the entry's for a later release; the share of an entry that had no coin when the bounty was settled goes to the poster to take back. A lister has to launch by the bounty's deadline to get the share. Anyone may |
| `bounty refund <bounty id>` | Takes back what is the owner's (`bounty_refund`): what a confirmation didn't fill, and after settling what nobody's use reserved |
| `bounty list [--mine] [--json]` | Every bounty on the network, newest first (`--mine`: the owner's own), each with its site, amount, limit, deadline, state, what use reserved and what its poster may take back (`bounty_list`) |
| `bounty show <bounty id> [--json]` | One bounty (`bounty_show`) |
| `bounty auto [on\|off]` | Whether the node takes the bounty steps for you (`bounty_auto`), off until you turn it on: it asks your agent, in the reply of its passed call on an entry of an open bounty's site, whether the entry answers the bounty, and on the agent's yes and then your own it confirms once that call's line is claimed. On or off, it settles your bounties past their deadline and takes back what is yours |

What the node asks its agent rides on a passed `unbrowse_do` or `unbrowse_call` result as `result.bounties.confirm`
(the bounty, the entry, the site, the amount and the limit), and the agent answers with `unbrowse_judge`, naming the
`bounty` and the `entry` (`unb judge <route> right --bounty 4 --entry 0x…`). Each is asked once: the node keeps what
the agent and the owner said in `~/.unbrowse/<chain>/bounty-auto-<wallet>.json`.

### coin

Route coins (spec ch. 6, `RouteCoins.sol`, `CoinStakes.sol`): each credited entry can have one coin, sold on a curve
against UNB. A paid fetch buys the entry's coin for its payer and stakes it without any of these commands; they are for
an owner who trades or stakes by hand. Every command is **running node**, and only the owner's word buys or sells.

| Command | What it does and prints |
|---|---|
| `coin`, `coin list` | What the wallet holds, per coin (`coin_holdings`): its entry, unstaked coins, each staked lot (exit delay, earning, pending, asked back and when ready), what its stake earned to claim, USDC a fetch paid whose buy is held, whether the wallet checked the entry, and the coin's price |
| `coin launch <entry> <unb>` | Launches the coin of an entry this wallet is credited with, with its first buy of `unb` UNB, untaxed (`coin_launch`). Only the entry's credited contributor may |
| `coin buy <entry> <unb>` | Buys an entry's coin with `unb` UNB on its curve, for at least its quote now less 1% (`coin_buy`). The coins arrive unstaked |
| `coin sell <entry> <coins>` | Sells unstaked coins for at least the quote now less 1% (`coin_sell`); staked coins are asked back first |
| `coin stake <entry> <coins> [<delay s>]` | Stakes unstaked coins in the lot of that exit delay, 24 hours unless named (`coin_stake`). They earn from the next epoch close once the wallet has checked the entry |
| `coin unstake <entry> <delay s> <coins>` | Asks coins back from that lot (`coin_unstake`): they stop earning and counting at once |
| `coin withdraw <entry> <delay s>` | Takes back the coins asked back from that lot, once its delay has passed (`coin_withdraw`) |
| `coin claim <entry>` | Claims what the wallet's stake in the coin earned from fetches, in USDC (`coin_claim`) |
| `coin delay [<s>]` | The exit delay the coins a paid fetch buys for this wallet are staked with (`coin_fetch_delay`); with a number it sets it on the chain. 24 hours until set |
| `coin dev-buy [<basis points>]` | The listing's first buy (`coin_dev_buy`): when an entry of this wallet's is credited, the node launches its coin with this share of the wallet's UNB and stakes the coins for the owner. 100 (1%) by default; 0 turns it off. Raising it past the default is asked in the owner's dialog |

### domain

| Command | What it does and prints |
|---|---|
| `domain status <domain>` | **Running node:** the wallet the domain's DNSSEC proof names, the epoch its escrow is released from, and the escrow (`domain_status`), as JSON. A domain is proven by DNSSEC only (R4.14): a TXT record `wallet=0x…` at `_unbrowse.<domain>` in a signed zone, submitted with `Domains.claimEscrow`. A domain without DNSSEC can't be proven; its site share waits in escrow until it has DNSSEC and a proof is submitted, and the answer's `note` says so |

### max-fetch

| Command | What it does and prints |
|---|---|
| `max-fetch` | The most the node pays to fetch one route another contributor lists (`max_fetch_usdc`, 0.05 USDC by default) |
| `max-fetch <usdc>` | Sets it, zero or more; at once. 0 uses only free routes and the node's own, which are always free to its own agents |

### network

| Command | What it does and prints |
|---|---|
| `network` | `off`, `on`, or `on, light`, with what each means |
| `network on` | Joins the peer network as soon as the running node sees it, once the terms are acknowledged |
| `network off` | Stays off the peer network from the next start; claims and staking on the chain go on ([NETWORK.md §10](NETWORK.md#10-opting-out)) |
| `network light` \| `network full` | Light mode on or off from the next start: only asks the network, seeds no fetched body ([NETWORK.md §8](NETWORK.md#8-seeding-light-mode-and-the-dark-set)) |

### browser

The browser add-on ([guides/the-browser.md](guides/the-browser.md)). None of these needs the node running.

| Command | What it does and prints |
|---|---|
| `browser [status] [--json]` | `present`, `missing` or `installing`, the browser program and the Chromium in use, and whether the node fetches it when needed; `--json` prints `{state, program, chromium, fetch, missing}` |
| `browser install [--from <path>]` | Fetches what the browser lacks: the program, from the node's own release checked against its signature (or the program or package tarball at `<path>`), then Chrome for Testing when there's no Chromium. Prints each step |
| `browser remove [--chromium]` | Removes the program the node installed (`~/.unbrowse/addons/browser`), and with `--chromium` the Chrome for Testing it downloaded; says what stays |
| `browser fetch [on\|off]` | Whether the node fetches the browser itself the first time a goal needs it (`fetch_browser`, on by default) |
| `browser headless [on\|off]` | Whether the node's browser stays headless whatever a site does (`headless_only`, off by default). On, nothing opens a window, and a walk that would need one answers `how: browse` or says why it can't. `UNBROWSE_HEADLESS=1` or `0` overrides it |

### update and restart

| Command | What it does and prints |
|---|---|
| `update` | **Running node:** checks for a newer release on its channel now, whether or not updates are on, and restarts into it once no call is under way; prints the version ready, "up to date", or that the rollout is halted. With no node running it fetches and checks the release here, and the node runs it at its next start. A build from source refuses ([guides/updates.md](guides/updates.md)) |
| `update channel` | The channel the node updates on: the one the owner picked, or `auto` |
| `update channel stable\|canary\|auto` | Picks it; `auto` lets a hash of the node's identity place it |
| `restart` | **Running node:** restarts once no call is under way, into the newest release unpacked here, else the same one; settings read at start (the chain, the peer network) take effect. Says so when no node runs |

### agent-user

Agents as an OS user of their own, `unbrowse-agent` ([guides/agents-os-user.md](guides/agents-os-user.md)). `install`
and `remove` need the machine's admin: `sudo` on macOS and Linux (they ask for the owner's password), an Administrator
PowerShell on Windows.

| Command | What it does and prints |
|---|---|
| `agent-user install [--agent <index>] [--revoke-found] [--yes]` | Shows its steps and asks first (`--yes` doesn't). Makes the node's folder the owner's alone, a new agent key (or key `index`), the user with no password, no admin rights and a private home, its settings (`UNBROWSE_NODE`, `UNBROWSE_AGENT_TOKEN`) in that home, and on macOS and Linux a sudoers rule letting the owner run programs as it. Lists the owner's files that hold a live agent key's token; `--revoke-found` revokes those keys. Run again, it keeps the user and refreshes the rest |
| `agent-user run -- <program> [args…]` | Runs the program as `unbrowse-agent`, with its settings, and exits with its code |
| `agent-user status` | As `unbrowse-agent`, tries to list the node's folder and read each file in it; prints what it could and exits 1, else says it can read none |
| `agent-user remove [--yes]` | Removes the user, its home and its sudoers rule (and on Windows its kept password). Its agent key works until revoked |

### passphrase and confirm

The owner's yes on a node with no screen ([SECURITY.md](../SECURITY.md#the-owners-yes)). Both read from the terminal
itself (`/dev/tty`, the console on Windows), never stdin.

| Command | What it does and prints |
|---|---|
| `passphrase` | Sets the owner passphrase, 10 characters or more, typed twice; setting the first one takes the owner's yes (the dialog, or with no screen a code shown on the terminal and typed back), and changing it asks for the one set now. The node keeps only its scrypt hash, sealed with the root key, in `~/.unbrowse/owner.passphrase` |
| `confirm [--wait <seconds>]` | **Running node:** shows each question the node waits on the owner's yes for (the recovery phrase, a password, a key backup, a new key, an agent's cap, a wallet to link), and allows it with the owner passphrase typed there, or refuses it on Enter. With nothing waiting it waits two minutes for a question, or `--wait` |

### passkey

Website passkeys, on by default; see the node [README](../unbrowse-node/README.md#website-passkeys-on-by-default) for
the risk. Enrolling and using need the running node; the rest reads and writes the vault directly.

| Command | What it does and prints |
|---|---|
| `passkey on` \| `passkey off` | Turns passkeys on or off. `UNBROWSE_PASSKEYS=0` or `=1` wins over the setting |
| `passkey never <site>` \| `passkey allow <site>` | Never enrol or sign in with one on that site and its subdomains, or allow it again |
| `passkey list` | One line each: id, site, account, `auto` or `manual`, last used. Never the credential |
| `passkey import <export \| ->` | Passkeys from a Bitwarden JSON, a CXF file or KeePassXC `.passkey`, sealed in the vault; says to delete the export |
| `passkey remove <id>` | Deletes it from the node; delete it on the site's account page too |
| `passkey enrol <site> [--cdp <address>] [--wait <seconds>]` | **Running node.** Attaches an authenticator to the site's pages and waits (600 s by default) for the site's own "add a passkey" flow; prints `enrolled passkey <id> on <site> for <account>` |
| `passkey use <site> --cdp <address>` | **Running node.** Loads the site's passkeys into a browser the node doesn't run, while it runs |

### session

| Command | What it does and prints |
|---|---|
| `session list` | Each host the node holds a session for, and its cookie count |
| `session import <host>` | Copies the browser chosen in Settings' cookies for one host into the node's session and its browser profile (`import.rs`); prints the count and how many profiles took them |
| `session import <host> --from <file \| ->` | The same from a cookie file: a cookie extension's JSON, `cookies.txt`, a Playwright or Puppeteer storage state, a `Cookie:` header; says to delete the file |
| `session forget <host>` | Drops the host's session |

### reports

| Command | What it does and prints |
|---|---|
| `reports` | Bug reports on or off, and whether telemetry or `UNBROWSE_REPORTS` set it, what a report holds, and how to stop them |
| `reports on` \| `reports off` | Sets the choice in `~/.unbrowse/reports.json`: off stops a running node at once, on takes the next start. With no choice saved, reports are off. Reports are off whenever telemetry is |

### share

Automatic sharing ([SHARING.md §4](SHARING.md#4-automatic-sharing)).

| Command | What it does and prints |
|---|---|
| `share` \| `share status` | The mode, today's listings against the cap, what stops listing now, and each route's standing (`shared`, `not yet: used on 1 of 3 days, 2 of 5 runs`, `kept off by you` and so on). From the running node, or from the files when it isn't running |
| `share used` \| `share all` \| `share off` | Sets the mode; at once. `off` delists nothing |
| `share route <id> on\|off` | Shares one route (even before it has earned it) or keeps it off the network from now on; what is listed stays listed until delisted (R2.14a) |
| `share per-day <n>` | The most routes the node lists by itself in a day |
| `share delist` | **Running node.** Delists every route this node lists, each kept off until shared again |

### sign-in

| Command | What it does and prints |
|---|---|
| `sign-in` | **Running node.** Links a wallet of the owner's to the node, which is optional: the node joins the network with its own wallet (spec §86), and a linked wallet receives withdrawals and can pay for several nodes. Opens the website's sign-in (email or Google through Privy), or, where no browser opens, prints its address to open on any device, waits up to 15 minutes for it, then says what linking does and shows which routes the node will share (the first listing waits for that) |
| `sign-in --wallet <address>` | **Running node.** Starts linking a wallet of the owner's own: prints the message that wallet signs (EIP-191, `personal_sign`, on any chain) and the nonce the node drew for it |
| `sign-in --wallet <address> --nonce <nonce> --signature <0x…>` | **Running node.** Links the wallet with what it signed, then the same as `sign-in` |
| `sign-in --key-file <path>` | **Running node.** Signs in with the wallet key in that file (one line of hex, `0x` optional; the file must be the owner's alone, `chmod 600`): the message is signed in this process and only the signature reaches the node, so no browser or other device is needed. The key signs nothing but this node's own sign-in message. The node still asks the owner's yes for the wallet: its dialog, or with no screen the owner passphrase on `unbrowse-node confirm`. Then the same as `sign-in` |

### telemetry

| Command | What it does and prints |
|---|---|
| `telemetry` | On or off, and whether `UNBROWSE_TELEMETRY` set it, what it sends, the install id, and how to stop it |
| `telemetry on` \| `telemetry off` | Sets the choice in `~/.unbrowse/telemetry.json`: off stops a running node at once, on takes the next start |

### terms

| Command | What it does and prints |
|---|---|
| `terms` | The terms version (`terms::TERMS_VERSION`), whether it is acknowledged, and whether the node joins the peer network |
| `terms show` | Prints the terms and the privacy policy this node carries |
| `terms accept` | Records the acknowledgement, which the node needs before it joins the network ([NETWORK.md §10](NETWORK.md#10-opting-out)). A running node sees it within a second |

### vault

Logins and cards, with no node running. What it prints is references and counts, never a secret; revealing a
password is the window's alone.

| Command | What it does and prints |
|---|---|
| `vault list` | `vault:<site>:<account>` and its kind for each login (with `vault:code:…` when it has a one-time code key), and `vault:card:<label>:<field>` for each card |
| `vault add <site> <account>` | A derived password, made from the root key and never stored |
| `vault add <site> <account> --stored` | A stored password, read from stdin |
| `vault remove <site> <account>` | Removes the login |
| `vault rotate <site> <account>` | A new derived password; the old one is gone, and the site isn't told |
| `vault code <site> <account>` | The one-time code key from stdin (`otpauth://` or the secret) |
| `vault import <export \| ->` | A browser's or password manager's export: passwords from a CSV or JSON, passkeys from a JSON that holds them. A login saved in an Android app comes in under the website whose `assetlinks.json` names the app, once the owner allows the app-to-site list the node shows (a site claims an app on its own). Prints counts and what it left out; says to delete the export |
| `vault card add <label>` | A card from stdin, one line each: number, expiry (MM/YY), name, and the security code before the name only while the vault keeps codes. Never from the command line |
| `vault card codes [on \| off]` | Whether the vault keeps cards' security codes, off by default. Card rules (PCI DSS) forbid keeping a code after a payment is authorised, even encrypted. Off, you type the code at each checkout; on (asks you first), a card added from then on keeps it and agents pay with it without you. Off forgets every kept code at once |
| `vault card approver [sdk \| dialog]` | Who approves a card payment an agent waits on. `dialog`, the default: the node's dialog on this screen, or the owner passphrase. `sdk` (asks you first, in the dialog, every time): a program holding the owner token approves one named payment with no dialog, for answering on another device such as the daemon hub's Telegram bot. Card payments only; every other owner question still opens the dialog. Any program running as you could then approve a waiting payment, so turn it on only on a machine where you trust what runs as you |
| `vault card limit <card> <site> <per payment> [per day]` | Saves a limit for a card on a site (its registrable domain); asks you first. It lets nothing through: every card fill and every route call that pays by card still asks you, since the node can't bind the amount to the charge. A `<per payment>` of 0 takes the limit away |
| `vault card limits` | Each limit, and what went out today |
| `vault card remove <label>` | Removes the card |

### wallet

| Command | What it does and prints |
|---|---|
| `wallet [--copy]` | The node's address; the linked owner wallet or that it isn't linked; the network; the gas the address holds there (read with a 5 s bound) and, on a live chain when it's short of one write at twice the gas price, where to get gas. With no node running. `--copy` puts the address on the clipboard and says which tool did it |
| `wallet address [--copy]` | The address alone, to pipe |
| `wallet restore` | The root key from its words on stdin: 12 seed words, or an older node's 24 words. For a machine where no one opens the window. Run it with the node stopped. Prints `restored <address>` and where the old key was kept |
| `wallet export <file>` | An encrypted backup of this node's key (spec §76.1 item 1.4), under the passphrase read from the first line of stdin (10 characters or more): an Ethereum keystore file, which any wallet that imports one also opens. Never writes over a file; only its owner can read it |
| `wallet import <file>` | The key in that backup, on this machine or a new one, the passphrase on stdin. Run it with the node stopped. The key it replaces is kept beside the root key; sign in again after, since a sign-in names the key it was made for |
| `nodes` | One wallet owning several nodes (spec §76.1 item 1.7): the owner's wallet, its deposit, and every agent key it granted, this node's marked (`owner_nodes`). A granted key only pays: each node signs its listings with its own wallet's key (issue #184) |
| `nodes renew` | Renews the owner's wallet's grants to this node's keys in one step before they run out (`wallet_renew`, spec §76.2 item 3): opens the sign-in page in its renewal mode, which sends them all from the wallet, and prints the same calls as `cast send` lines. Each runs to its key's expiry, 30 days on; the node never asks for a grant without one. `nodes` says when one is due |
| `money` | The balance in dollars, what agents can spend, what starts the node ("Add $X to start"), each agent's daily limit and what it spent today, earnings, and the page that adds funds (`money`) |
| `earnings` | What the wallet earned, by where it came from, in USDC (`earnings`): from staking route coins and as a contributor, each claimed and still to take, and the route share its entries' lines sent to their coins. Claims are paid whole: nothing vests |
| `nodes grant` | The calls the owner's wallet sends so this node's agent keys pay from its deposit, one `authorizeAgent` each at the key's cap and expiry, as `cast send` lines (`wallet_grant`). The node can't send them: a grant is the wallet's own. Once the chain has them the node names the wallet as payer, from the next voucher epoch a key hasn't begun |

---

## 3. `unbrowse`, the installed command

`unbrowse-sdk/typescript/src/cli.ts`; the Python package installs the same.

| Command | What it does |
|---|---|
| `unbrowse app` | Opens the window, which starts the node when none is running |
| `unbrowse start` | `unbrowse-node`: runs the node without the window. It serves agents at once and stays off the peer network, saying so, until `unbrowse terms accept` |
| `unbrowse install [--skill] [--commands] [--dry-run]` | What the app puts in place on its first start after the terms are accepted: the skill in the skills folder of every agent found here, `unb`, `unbrowse-node` and `unbrowse` linked into `~/.local/bin`, and one guarded line for that folder in the file the owner's shell reads at login, when it doesn't name it already. `--dry-run` writes nothing and says what it would do; `--skill` or `--commands` does one half (`install.rs`) |
| `unbrowse agent`, `chain`, `bounty`, `coin`, `max-fetch`, `network`, `passkey`, `reports`, `restart`, `session`, `share`, `sign-in`, `telemetry`, `terms`, `update`, `vault`, `wallet` … | `unbrowse-node <the same>` (`NODE_COMMANDS`); in the app's install, `unbrowse` is `unb` under that name and passes any word that isn't its own to the node |
| `unbrowse skill [dir]` | Puts the agent skill in `dir` (default: every agent's skills folder found here). A global npm install does it by itself when Claude Code is there, and so does the app's first start. What was there, unless it is a copy we wrote, unchanged, is moved aside to `unbrowse-kept/<name>.before-unbrowse-<time>` beside the skills folder, never deleted ([the skill](reference/the-skill.md)) |
| `unbrowse where` | Where the programs are (`UNBROWSE_BIN`, the app, the platform package, or `PATH`) |
| `unbrowse <anything else>` | `unb <the same>` (§4) |

---

## 4. `unb`, the agents' shell client

`unb` talks to the node's agent API with an agent's token: `UNBROWSE_AGENT_TOKEN`, and `UNBROWSE_NODE` for the node
(default `http://127.0.0.1:7788`). Before it sends the token, it asks the node to prove it is the node the token is for
(`GET /v1/node/proof`), so a process that took the port never sees the token. It prints the node's JSON reply, and
exits 1 when the reply has an `error`.

`install`, `skill`, `where`, `app` and `start` are the exceptions: they touch the node's files or its own start and
need no token, so a person can run them before any agent key exists. The app's install links this program as both `unb`
and `unbrowse`; run as `unbrowse`, any word that isn't one of its own (`install`, `skill`, `where`, `app`, `start`, or
one of the commands below) is passed to `unbrowse-node`, so `unbrowse vault …` and `unbrowse update` work too.

| Command | Sends |
|---|---|
| `unb do <goal words…> [--url <page>] [name=value …]` | `POST /v1/do` |
| `unb search [words]` | `GET /v1/routes?q=` |
| `unb call <route id> [name=value …]` | `POST /v1/routes/{id}/call` |
| `unb browse <command…> [--site <site>] [--goal <words>]` | `POST /v1/browse` |
| `unb challenge <look\|click x y\|drag x y to_x to_y\|type --text -\|press --key <key>\|wait --ms <ms>\|done> [--url <page>] [--site <site>] [--session <name>]` | `POST /v1/challenge`. What `type` types is read from stdin (`printf '%s' "$CODE" \| unb challenge type --text -`), never taken from the command line, where other programs read a process's arguments while it runs: `--text <words>` is refused, exit 2, before anything is read or sent |
| `unb open <unbrowse://link>` | `GET /v1/open?q=` |
| `unb logins` | `GET /v1/logins` |
| `unb whoami` | `GET /v1/whoami` |
| `unb judge <route id> <right\|wrong> [--url <page>] [--why <text>] [--what <words>] [--fields <path,…>] [--writes\|--reads]` | `POST /v1/routes/{id}/judge` (`--writes`: calling it changes the site, so it is held as a write, R1.25; `--reads` takes that back) |
| `unb report <kind> <summary…> --expected <what> --got <what> [--route <id>] [--goal <words>] [--url <page>] [--tool <tool>] [--error <text>]` | `POST /v1/report` |
| `unb connect [agent index] [--dry-run] [--yes]` | Starts the node if it isn't running, checks agent `index` (default: the key the node made itself) is live on it, and registers it with Claude Code as `unb mcp --agent <index\|first>`, so no command line or config holds its token. First it shows what an older Unbrowse left on the machine (Claude Code user and local scope, the old plugin, Codex, Cursor, VS Code, Gemini, Zed, the old sign-in files), each as hosted, your node or not ours, with a key shown by its last 4 characters only. It backs the old entries up to `~/.unbrowse/migration/<UTC time>/` (private; it holds their keys), checks the new entry answers `initialize` and `tools/list`, adds it as `unbrowse-next`, removes each old entry by name and scope, then renames it `unbrowse`. An entry that isn't Unbrowse's is never touched. A failed check changes nothing. Without a terminal it only shows the plan unless `--yes`; `--dry-run` only shows it |
| `unb connect --client <client\|all>` | Writes the node's first agent into each client named (again, or a comma list; `all` for every one found here) as `unb mcp --agent first` with `UNBROWSE_NODE`, never a token: Claude Code through `claude mcp add` when `claude` is on the PATH, else in `~/.claude.json`; the others in their own config files, in the shape each reads. Clients: `claude-code`, `claude-desktop`, `cursor`, `codex`, `vscode`, `windsurf`, `devin`, `gemini-cli`, `antigravity`, `qwen-code`, `copilot-cli`, `factory-droid`, `kiro`, `warp`, `amp`, `opencode`, `kilo-code`, `augment`, `junie`, `cline`, `roo-code`, `lm-studio`, `hermes`, `openclaw`; only an installed one is written ([where each keeps it](guides/connect-your-agent.md#agents-the-app-connects)). Each entry is checked (`initialize`, `tools/list`) before anything is written; every file is backed up beside itself (`.before-unbrowse-<time>`, private) and recorded under `~/.unbrowse/connect/`. An `unbrowse` entry that isn't Unbrowse's is left alone. The window's Connect screen does the same (`agent_connect`) |
| `unb connect --undo --client <…>` | Puts back what the window's Connect or `connect --client` last changed: the whole file while nothing else changed it since, else only the `unbrowse` entry |
| `unb connect --undo [<time>] [--purge]` | Puts back what connect replaced (the newest backup, or the one named) and removes the node's entry; `--purge` then deletes the backup |
| `unb install [--skill] [--commands] [--dry-run]` | The app's first-start install, from a shell, with no node running: the skill into every agent's skills folder found here, `unb`, `unbrowse-node` and `unbrowse` linked into `~/.local/bin`, and the PATH line when the owner's shell file doesn't name that folder already. Prints what it did (or, `--dry-run`, would do) as JSON and in words. A program running from a disk image or a translocated copy puts no commands on the PATH and says to open the app from Applications first |
| `unb skill [dir]` | The skill alone: into `dir`, else every agent's skills folder found here. What is there that Unbrowse didn't write is kept beside it, never deleted |
| `unb where` | Where the programs run from, and which of them are there |
| `unb app` | The window, which starts the node when none is running |
| `unb start [<words>…]` | `unbrowse-node` with those words (`unbrowse start --from <tag>`) |
| `unb grant [<n> \| first]` | Lets agent `n` (else the node's first key) be used by a client on this machine: asks the owner as `agent token` does and keeps the yes as that agent's grant, for `unb mcp --agent`. Never prints the token |
| `unb mcp [--agent <index\|first>]` | The node's MCP server over stdio, for an agent's MCP config: each JSON-RPC message goes to the node's `/mcp` signed with the named agent's token, which it reads from that agent's grant (`unb grant`, the owner asked once), never the keystore, else `UNBROWSE_AGENT_TOKEN`, after the node proves itself, and an answer goes back only when the node signed it. With no node running at `UNBROWSE_NODE` (after a reboot, say) it starts the one beside itself and waits up to 15 s for it |

An older script's `--pays-usd` is read past: the node pays a route's fee itself, up to the owner's per-fetch maximum.

`unb browse` takes the page-driving commands only (`app/src/browse.rs` `COMMANDS`): `open`, `goto`, `snapshot`,
`click`, `dblclick`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `focus`, `scroll`,
`scrollintoview`, `upload`, `get`, `is`, `find`, `wait`, `back`, `forward`, `reload`, `eval`, `screenshot`, `close`,
and `ask_owner <what you need> [--timeout <seconds>]`; none picks another browser, profile or session. A vault value
goes in by reference: `fill <ref> vault:<site>:<account>`, `vault:code:<site>:<account>` for its one-time code,
`vault:new:<site>:<account>` for a fresh derived password, `vault:card:<label>:<field>` for a card.

The same surface is a library: `Unbrowse` (also `UnbrowseNode`) in the `unbrowse` package for TypeScript and Python
has `do`, `call`, `search`, `browser()`, `logins`, `cards`, `whoami`, `judge` and `report`, reads the same two variables, and is tested
against the same `agent-api.json` ([unbrowse-sdk/README.md](../unbrowse-sdk/README.md)).

---

## 5. The agent API and MCP tools

On `127.0.0.1` only, each request signed with an agent's token (`x-unbrowse-key`, `x-unbrowse-time`, `x-unbrowse-nonce`, `x-unbrowse-signature`: an HMAC-SHA256 keyed by the token over the method, the host and port it is sent to, the path with its query, the body's SHA-256, the time and the nonce; `unbrowse_core::signed`), the token never sent; the node signs its answer (`x-unbrowse-reply`). A plain `Authorization: Bearer` is taken only while the owner allows it (`unbrowse-node agent bearer on`). Each primitive is one entry in
`PRIMITIVES` (`app/src/api.rs`); the HTTP route and the MCP tool are both made from it and run the same code, and
[`agent-api.json`](../unbrowse-node/agent-api.json) is written from that list
(`UNBROWSE_WRITE_AGENT_API=1 cargo test -p unbrowse-node-app the_agent_api_manifest_is_current`). The tests of `unb`
and both SDKs read that file, so a primitive added fails them until each surface has it.

| HTTP | MCP tool | `unb` | What it does |
|---|---|---|---|
| `POST /v1/do` `{goal, url?, inputs?, session?, browser?}` | `unbrowse_do` | `do` | Calls the route for the goal; else tries other contributors' listings for the page's site; else walks the page and learns one; else opens it for the agent to drive. The reply's `how` is `called`, `network`, `learned` or `browse`. `browser` (`auto`, `if_present`, `never`) says whether it may use the browser; a goal that needs one it can't use answers 422 `browser_missing` ([guides/the-browser.md](guides/the-browser.md#3-browser_missing)) |
| `POST /v1/browse` `{do, site?, goal?, session?}` | `unbrowse_browse` | `browse` | Drives the node's browser by hand, learning from each step. `["ask_owner", "<what>"]` hands the page to the owner and waits (5 minutes, `--timeout` up to 1800 s). Each session (the MCP client's, else `session`) has its own tab in a site's browser |
| `POST /v1/challenge` `{action, url?, site?, session?, x?, y?, to_x?, to_y?, text?, key?, ms?}` | `unbrowse_challenge` | `challenge` | A page that asks for a person, shown as a picture (`image`: a path the node wrote, at `w`×`h` CSS pixels) with its `text` and `asks`. `look` shows it; `click`, `drag`, `type`, `press`, `wait` and `done` take one step and answer the page again. The agent's own model reads the picture; `asks` is the page's own answer |
| `GET /v1/routes?q=` | `unbrowse_search` | `search` | This node's routes and other nodes' for the query, ranked together; a network route is `remote: true` with its fee, `over_max` when over the per-fetch maximum, `site_policy` when its site's own policy refuses it (delisted, or under the site's fee floor, R4.17), and `checked` when more than one owner answered |
| `POST /v1/routes/{id}/call` `{inputs}` | `unbrowse_call` | `call` | Calls a route, or another contributor's entry by id, with inputs |
| `GET /v1/logins` | `unbrowse_logins` | `logins` | The vault's logins and cards, by reference only |
| `GET /v1/whoami` | `unbrowse_whoami` | `whoami` | The agent's identity |
| `POST /v1/routes/{id}/judge` `{verdict, url?, why?, what?, fields?}` | `unbrowse_judge` | `judge` | What the agent saw in a route's answer, kept on the route (`judged`): `wrong` with `url` and `why` sets it aside for that page, so `do` learns the page afresh or opens it for hands (and a learn that finds the same call opens it); `what` renames it, except a route listed on the network; `fields` become its default fields, never chosen again by the node; `right` with `url` takes back a wrong. A learn of the same call keeps all of it. Each judgment is in the owner's activity |
| `POST /v1/report` `{kind, summary, expected, got, route_id?, goal?, url?, tool?, error?}` | `unbrowse_report` | `report` | Reports a problem with Unbrowse itself (`kind`: `wrong_data`, `false_success`, `failed`, `slow`, `confusing`, `other`). The node scrubs it, adds the route's shape and the agent's last error, and sends it to the relay, which files it as a public issue on unbrowse-ai/unbrowse (`app/src/report.rs`; the root README's [Bug reports](../README.md#bug-reports)). An agent's report waits for the owner to read and send it in their window (`report_send`, asked in the node's dialog with the text shown): the reply's `report` is `waiting_for_owner`, `off` or `refused`, with what was scrubbed and the report as it would be filed |

What the owner's own browsing session gave a page (`Route::given` on a route with `session_gave`: text they typed,
an option they chose, a click's value) is never said back to an agent. Every answer that shows a route (`search`, `do`,
`inspect`, `judge`, the goal's options, a `report`'s route shape) shows such an input with `default: null` and
`supply: true`, and shows the route's address and steps with that value masked: a step's query is dropped, a fixed path
segment the walk didn't read from served bytes reads `{fixed}`, a fixed or derived address goes as its origin only, and
any whole occurrence left anywhere in the answer reads `{name}` (`store::Route::shown_to_an_agent`,
`api::said_to_an_agent`). An agent's call doesn't use the owner's kept value either: it runs the route with those
defaults cleared (`Route::usable_by_an_agent`), so an input it leaves out is refused by name ("the route needs a value
for q"), and a route that still carries such a value anywhere else the call would send it (a fixed path piece, a header,
a body field, a fixed value's source address) is refused before anything is sent, naming the place: "this route was
taught by the owner's own browsing and still carries what they typed at step 1 path[1]: walk the page again as the
agent" (`Route::callable_by_an_agent`, read by the sharing boundary's `recipe::still_carries`). A fixed value at the
very place another step takes the input is the agent's there. What its call says back, answer or error, crosses the same masking, since a fixed part of an address the
call still sends may hold the owner's value: such a value the site says back reads `{name}` unless the agent sent it
itself (`api::said_to_an_agent_who_sent`). The owner's own calls are unchanged. A value an agent named for a walk (`keep_as`) is its own word and is
shown as a default, to any agent key the owner has made: the route doesn't record which key named it.

Nor is what the node holds as a site's session. Every answer to an agent, whatever primitive gave it, crosses one last
pass (`api::run_primitive`, `session_held`) that says `{session}` wherever a value of any jar, a cookie of a running
site browser's own cookie store (HttpOnly ones included), a page storage value kept beside a jar, a cookie or credential
a route carries, or a session value a walk's capture held (a value an answer delivered that a later request sent back
included), stood, however it is written: a page's text, a snapshot, `eval document.cookie`, a walk's list of
calls, an error. A flag or a value under 4 characters is left alone, and one under 12 is matched only as a whole word.
The running browsers are asked at once, within 10 s; when one can't be read the answer isn't given (503). A script or a page that changes a cookie
before showing it isn't caught: SECURITY.md, "What isn't defended".

MCP is `POST /mcp`, Streamable HTTP, JSON-RPC: `initialize`, `ping`, `tools/list` (the primitives above) and
`tools/call`.

Four routes are not primitives:

| Route | What it is |
|---|---|
| `GET /v1/health` | Whether the node is alive and whether it is ready: `{alive, ready, checks}`, each of `chain`, `settlement`, `keys`, `identity` and `network` with `ok` and a line saying what it is or why not (`health.rs`). Always 200 while the node answers; `ready` is every check ok. The node joins the peer network, where it announces and serves, only once its chain, Settlement and key are ready. No token needed |
| `GET /v1/node/proof?challenge=<32 bytes, hex>&key=<key>` | The node proving it is the node a client means, to the key the client names and no other. An agent names its token's key, `hex(keccak256("unbrowse/node-key\n" ‖ token))`, and gets `agents: [hex(keccak256("unbrowse/node-proof\n" ‖ token ‖ "\n" ‖ port ‖ challenge))]`; another node names the owner's address from the node's ad and gets `address` and the owner key's `signature` over the challenge and port. Any other key, or none, gets `agents: []` only: no address, no count of keys. No token needed (shape: `local.node_proof` in `agent-api.json`) |
| `POST /v1/remote/receipt` | A payer's node sends a passed line for a body this node served, to keep and claim (`network::accept_receipt`) |
| `POST /v1/remote/call/{id}` | Retired: answers an older node with the reason. A caller fetches the body and runs it itself now |

Every request must name this node's own host and port (`own_host_only`).

---

## 6. Owner commands

The window and the SDK's owner client send these as `POST /owner/<cmd>` (the route `/owner/{cmd}`) with a JSON body, using the
owner's token from `~/.unbrowse/owner.token`, minted fresh on every node start (`main.rs` `owner`). `GET /owner/events`
is a server-sent event stream of what happens on the node; `GET /owner/frame?walk=` is a walk's latest picture, as a
JPEG. An unknown command is refused.

Some run only on the owner's yes, asked by the node itself whoever sends them: `wallet_phrase`, `vault_reveal`,
`wallet_export`, `wallet_restore`, `wallet_import`, `agent_set_cap`, `agent_create`, `link_wallet`, `wallet_send`, and `save_settings`
when it lets the node spend more (`commands::asks_the_owner`, `store::SPENDING`). A withdrawal to a linked wallet
the node didn't seal asks too (SECURITY.md, "Linking a wallet"). The node opens a
dialog, or on a node with no screen waits on the owner passphrase (`confirm`).

| Command | Body | What it does |
|---|---|---|
| `identity` | | The node's address, and whether its key was just created |
| `link_status` | | The linked owner, and whether a sign-in is waited on |
| `link_message` | `{owner}` | The message the owner's own wallet signs to sign in, and the nonce the node drew |
| `link_wallet` | `{owner, nonce, signature}` | Signs the owner in with what their wallet signed |
| `link_start` | | Opens the `/link` page in the owner's browser, to link a wallet (optional) ([ONBOARDING.md §2](ONBOARDING.md#2-linking-a-wallet-optional)) |
| `unlink` | | Forgets the owner's signature. The wallet's grants to this node's keys stay on the chain until they run out or the wallet revokes them: only the wallet can |
| `money` | | The Money screen: `balance`, `available_to_spend`, `needed_to_start` (the smallest top-up that starts the node: registration, deposit floor and network fees, less what it holds), `add_funds_url` (`{site}/fund/#node=…&chain=…&min=…&nonce=…`), `payments` (`test`, `open`, `not_open`, `offline`, `starting`), `parts`, each agent's `daily_limit`, `spent_today` and `pays_from`, `earnings` (`available`: the route shares ready to take, in USDC) and `first_buys`. Every sum a decimal string |
| `add_funds` | | Opens the page that adds funds in the owner's browser; answers `url` and `opened` |
| `funding` | | On a live chain: what the key lacks for gas, what its identity needs once (`identity_usdc`), its deposit and what to send (`fund_usdc`), and Arc's CCTP and Gateway contracts for USDC from another chain (`other_chains`) |
| `share_status` | | What `share` prints, as JSON (`autolist::view`) |
| `share_route` | `{id, on}` | One route shared or kept off; turning it off delists nothing (R2.14a) |
| `delist_all` | | Delists every route this node lists |
| `node_info` | | Name, version, API port, whether a dev build |
| `sites` | | Sites the node has a browser profile or session for |
| `sessions` | | Hosts with a session, and cookie counts |
| `forget_session` | `{host}` | Drops a host's session |
| `settings` | | The settings |
| `save_settings` | `{settings}` | Saves them |
| `routes` | | Every route |
| `delete_route` | `{id}` | Deletes one |
| `call_route` | `{id, inputs?}` | Calls a route as the owner |
| `activity` | `{limit?}` | The newest activity lines |
| `agents_list` | | Agent keys |
| `agent_create` | `{name, cap_usdc, days}` | Makes and authorises an agent key; `cap_usdc` is the most it spends a day, in USDC (`cap_unb`, its old name, is still taken) |
| `agent_revoke` | `{index}` | Revokes one on the chain |
| `vault_list` | | Logins, by reference |
| `vault_add` | `{site, account, kind, password?}` | Adds a login |
| `vault_remove` | `{site, account}` | Removes one |
| `vault_reveal` | `{site, account}` | A stored login's password, for the window only |
| `vault_rotate` | `{site, account}` | A new derived password |
| `vault_code` | `{site, account, key}` | A one-time code key |
| `vault_import` | `{csv}` | An export's text |
| `vault_cards` | | Payment cards: `label`, `last4`, `created`, `code` (kept with its security code); never a number |
| `vault_card_add` | `{label, number, expiry, name, cvv?}` | Keeps a card (expiry MM/YY); `cvv` is kept only while `keep_card_codes` is on. Answers the card as `vault_cards` lists it |
| `vault_card_remove` | `{card}` | Deletes a card and its limits, on the owner's yes |
| `passkeys` | | Whether passkeys are on, the never list, and the passkeys |
| `passkey_never` | `{site, never?}` | Never, or allowed again |
| `passkey_remove` | `{id}` | Deletes one |
| `passkey_enrol` | `{site, cdp?, minutes?}` | Arms enrolment for `minutes` (10 by default) |
| `passkey_use` | `{site, cdp}` | Loads a site's passkeys into another browser |
| `wallet_phrase` | | The recovery phrase: 12 seed words, which open this node's wallet in any wallet app, or an older node's 24 words, which bring back this node only |
| `confirmations` | | The questions a node with no screen waits on the owner's yes for: `id`, `question`, `seconds_left` |
| `confirm` | `{id, passphrase}` | Allows a waiting question with the owner passphrase, or refuses it with none; 3 wrong refuse it, 5 wrong in a row lock all for 15 minutes. `unbrowse-node confirm` sends it from the terminal |
| `wallet_export` | `passphrase` | An encrypted backup of the node's key (`address`, `backup`: keystore JSON) |
| `wallet_import` | `backup`, `passphrase` | Restores the key the backup holds, keeping the one it replaces |
| `agent_set_cap` | `index`, `cap_usdc` | An agent key's cap an epoch, kept at renewal |
| `wallet_grant` | | What the owner's wallet sends so this node's keys pay from its deposit |
| `wallet_send` | `{to, amount}` | Sends USDC from the node's address to `to`, on the owner's yes: the way on for a withdrawal or earnings paid to the node with no linked wallet, which the top-up leaves out of the deposit. Where USDC is the gas, keeps what a full claim batch needs |
| `owner_nodes` | | The owner's wallet, its deposit, every key it granted, and `renew_by` when a grant runs out within a week |
| `wallet_renew` | | Renews the wallet's grants in one step: the page's url, whether it opened, and the calls |
| `wallet_restore` | `{words}` | Restores the root key from them |
| `chain_status` | | Whether the chain is up, its error, RPC, network and deployment |
| `faucet` | `{amount}` | Mints test tokens: only the token's owner, so a devnet's |
| `deposit` | `{amount}` | Deposits Settlement USDC |
| `request_withdraw` | `{amount}` | Asks to withdraw; it waits 2 epochs |
| `withdraw` | | Withdraws what is due |
| `wallet` |  | The owner's wallet on the chain: what it holds, the deposit, earnings and what is ready to take, and the node's fee and how it is split. |
| `earnings` |  | What the wallet earned, by where it came from, in USDC: from staking route coins (its staked, checked coins' part of each fetch on their entries), as a contributor (route shares the fetch owed it for lines on its entries with no coin), each claimed and still to take; the route share its entries' lines sent to their coins (the coins' money, paid to whoever stakes them); and the USDC waiting in all. Claims are paid whole: nothing vests. |
| `collect_earnings` |  | Takes everything waiting for the wallet: each route coin's stake earnings in USDC and the route shares the fetch owes it as a contributor. Answers the transactions. |
| `coin_holdings` |  | What the wallet holds in route coins, per coin: its entry, the coin's state, unstaked coins, each staked lot (exit delay, earning, pending, asked back and when ready), what its stake earned to claim, USDC a fetch paid whose buy is parked, whether the wallet checked the entry and its latest paid call passed (both needed for its stake to earn and count), and the coin's price; the route shares the fetch owes it as a contributor, and the exit delay its fetches stake with. |
| `coin_launch` | `{entry, unb}` | Launches the route coin of an entry this wallet is credited with (its id, `entry`), with its first buy of `unb` UNB from the wallet, untaxed, for the wallet: only the entry's credited contributor may. Never sent twice while one may still land. |
| `coin_dev_buy` | `{bps}` | The listing's first buy: once an entry of this wallet's is credited, the node launches its coin with this share of the wallet's UNB at that moment, in basis points, and stakes the coins for the owner (`decide.dev-buy-default-on`). 100 (1%) by default; 0 turns it off. A wallet with no UNB, or too little for the curve to sell anything, launches nothing, and the route still lists. With `bps` it sets it (raising it past the default is asked in the owner's dialog: it spends UNB by itself); null only reads it. |
| `coin_buy` | `{entry, unb}` | Buys an entry's coin with `unb` of the wallet's UNB, on its curve, for at least its quote now less 1%. The coins arrive unstaked: coin_stake stakes them. Only the owner's word buys a coin (`coin.stake`). |
| `coin_sell` | `{entry, coins}` | Sells `coins` of the wallet's unstaked coins of an entry, for at least the quote now less 1% (staked coins are asked back first, coin_unstake). Only the owner's word sells a coin. |
| `coin_stake` | `{entry, coins, delay}` | Stakes `coins` of the wallet's unstaked coins of an entry in its lot of exit `delay` seconds (null: 24 hours, `route_coin.unstake_delay`). They earn from the next epoch close once the wallet has checked the entry, and count in the entry's rank by their delay while the wallet's own latest paid call on it passed. |
| `coin_unstake` | `{entry, delay, coins}` | Asks `coins` back from the wallet's lot of exit `delay` seconds in an entry's coin: they stop earning and counting at once, and coin_withdraw takes them back after that lot's delay. |
| `coin_withdraw` | `{entry, delay}` | Takes back the coins asked back from the wallet's lot of exit `delay` seconds in an entry's coin, once ready. |
| `coin_claim` | `{entry}` | Claims what the wallet's stake in an entry's coin earned from fetches, in USDC. |
| `coin_fetch_delay` | `{delay}` | The exit delay, in seconds, the coins a paid fetch (or a bounty) buys for this wallet are staked with (`coin.fetch-stakes`); with `delay` it sets it on the chain, null only reads it. 24 hours until set. |
| `coin_rank` | `{entries}` | Entries' ranks as this node computes them from the chain (`rank.score`: the square root of their counted stake's collateral value times their coin's time-weighted market cap, in UNB; 0 is no rank), with the counted stake, collateral, market cap and price each was valued at. A pick goes to entries in proportion to their rank, keeping 5% of reads for entries with none. |
| `domain_status` | `{domain}` | The wallet a domain's DNSSEC proof names, when its escrow is released, and the escrow; for an unproven domain, a `note` that only DNSSEC proves one |
| `advance_day` | | Devnet only: mines an epoch of blocks, its clock moving with them |
| `list_route` | `{id}` | Lists a route ([SHARING.md §2](SHARING.md#2-signed-listings-under-posted-roots)) |
| `set_pricing` | `{fee, auto, floor, ceiling}` | The node's fee, and auto pricing |
| `delist_route` | `{id}` | Delists one, and keeps it off |
| `routes_on_chain` | | What the chain says of each kept route: whether it is listed and live, its fee, whether this node holds it to serve, its entry's route coin, the owner's coins of it (staked and unstaked), and the entry's rank |
| `agents_spend` | | Each agent's spend this epoch against its cap |
| `claim_now` | | Claims every line at once, the lines it holds as a watchtower for other payers included |
| `board` | | The leaderboard |
| `bounty_post` | `{site, amount, limit, days}` | Posts `amount` of the wallet's UNB for `site` (example.com), with the most it pays a coin, fees and tax included (`limit`, UNB; null buys at market), open for `days` (null: 30). The owner releases it by confirming an entry of the site once its own paid call on that entry passed and was claimed (bounty_confirm), which buys that entry's coin once it trades, half staked for its contributor and half for the owner; after the deadline the site's use by others releases at most 5% of the USDC their lines paid, and the rest is the owner's to take back (bounty_refund). Never sent twice while one may still land. |
| `bounty_confirm` | `{id, entry}` | Confirms one of the owner's bounties for an entry of its site (`entry`), once the owner's own paid call on that entry passed and was claimed as a counting line since posting: it buys the entry's coin at once within the bounty's limit, paying at most the curve's quote with 1% slippage, read when the confirmation was allowed and never raised for a retry, or, with no cap kept (the bounty steps off, or allowed before the coin traded), the quote when it is sent, with the same slippage (`maxCost`: a price pushed since makes it fail, and nothing is spent: price moved: wait, or post the bounty again with a limit), half staked for the contributor and half for the owner. Refused before then, for an entry whose coin isn't launched yet (a bounty never launches one), and while the coin is in its snipe window, with nothing spent. A lister has to launch by the bounty's deadline (and its snipe window pass before it) for a confirmation, and by the deadline to get a share by use. The node confirms on its own only with a cap kept from the owner's yes: one allowed before the entry's coin traded needs a hand confirm (`bounty confirm`), or posting the bounty again with a limit. Never sent twice. |
| `bounty_settle` | `{id}` | After a bounty's deadline, fixes what its site's use by others releases (at most 5% of the USDC their counting lines paid while it was open, never more than the bounty); the rest becomes the poster's. Anyone may. |
| `bounty_release` | `{id, entry}` | Releases an entry's share of a settled bounty by use (`entry`), in proportion to the USDC its lines paid while it was open: it buys the entry's coin within the bounty's limit, and only while the coin's price is steady (within 1% of its 15-minute mean and of its settled price), else it is refused and can be sent again later. What the limit doesn't fill stays the entry's, for a later release. The share of an entry that had no coin when the bounty was settled goes to the poster to take back (bounty_refund), even if its coin launched since: a bounty never launches a coin. A lister has to launch by the bounty's deadline to get the share. Anyone may. |
| `bounty_refund` | `{id}` | Takes back what is the owner's of one of its bounties: what a confirmation didn't fill, and after its deadline (settling it first) what nobody's use reserved. |
| `bounty_list` | `{mine}` | Every bounty on the network, newest first, each with its site, amount, limit, deadline, state (open, to settle, confirmed, settled), what use reserved and what its poster may take back; `mine` keeps the owner's own. |
| `bounty_show` | `{id}` | One bounty: its site, amount, limit, deadline, state, what use reserved and what its poster may take back. |
| `bounty_auto` | `{on}` | Whether the node takes the bounty steps for the owner, off until the owner turns them on: it asks the owner's agent, in the reply of its passed call on an entry of an open bounty's site, whether the entry answers the bounty; on the agent's yes and then the owner's own, it confirms the bounty once that call's line is claimed. Either way it settles the owner's bounties past their deadline, takes back what is the owner's, and releases by use the shares of entries the owner lists. `on` sets it; null only reads it. The other bounty commands work either way. |
| `hands` | | Pages the owner can take |
| `hands_watch` | `{site}` | Starts the live picture of a site's page |
| `hands_stop` | | Stops it |
| `hands_input` | `{site, …}` | A click or key on the page |
| `hands_give_back` | `{site, done?}` | Gives the page back: done, or can't do it |
| `browsers` | | The browsers found and the one in use |
| `choose_browser` | `{path}` | Picks one |
| `download_browser` | | Fetches what the browser lacks: the program from the node's release, and Chrome for Testing when there's no Chromium |
| `import_session` | `{host}` | `session import <host>` |
| `update_status` | | The running and newest versions, the channel, and any halt |
| `update_now` | | `update`: checks now and restarts into a newer release |
| `restart` | | `restart` |
| `accept_terms` | `{keep_off}` | Records that the owner was shown the current terms, and their answer on the network: `keep_off` keeps the node off it, else it joins. Answers the settings as kept. |
| `card_limit` | `{card, site, per_payment, per_day}` | Stores per-payment and per-day limits for a card on one site. Card fills and route calls currently always ask because the node cannot bind a checkout amount and currency to the outgoing charge. A per_payment of 0 removes the stored limit. |
| `card_limits` |  | Stored per-payment and per-day limits for each card and site, and what was counted today. Unknown or unbound charge amounts are never counted as within a limit. |
| `chain_kept` |  | The writes the node signed that must not go twice (a deposit, a stake, a bounty post, a registration, a USDC send) whose fate it can't prove yet, each with whether what it would change reads otherwise than before, as the node's RPC reads it (a hint, never a proof). Each stays until its block proves it landed or didn't, or you let it go with chain_kept_release. |
| `chain_kept_release` | `{key}` | Forgets one kept write (by its key, from chain_kept) after you have checked on the chain that it never landed, so the node may send it again. Always asked in your own dialog: a write let go that may still land can be paid twice. |
| `checkout_holds` |  | The sites held for a card checkout: from the moment the owner is asked about a card for a site until they say the checkout is finished or dismissed, no agent command reaches the site, nor any host the checkout names (its frames, its forms' actions, what its pages submitted to), and no route, heal or shared route of the node is sent there. While any checkout is held, the node also calls no route of any method on any site, runs no agent command in any page of any site but close and the tab's address and title, pauses the agent's other open pages, and its browsers reach only the held hosts (the checkout's own browser reaches any). Each with the hosts held (at most 8 besides the site; `more` counts those it named past them), since when, when the owner is next reminded (once a day: time never ends a hold), and what the owner should be told. |
| `checkout_release` | `{site, how}` | The owner says a held checkout is finished or dismissed (site `*`: every one), and agents may act on the site again. Only the owner ends a hold: asked in the node's own dialog, never by an agent. |
| `entries` | `{site}` | Every route listed on the chain with its live entries, the default first and unverified ones tagged, ranked by this node from the chain's own record. `site` keeps one site's. |
| `keep_card_codes` | `{on}` | Whether the vault keeps card security codes (#185), off until the owner turns it on. Card rules (PCI DSS) forbid keeping a code after a payment is authorised, even encrypted. Off, a card is kept with no code and a checkout asks the owner to type it; on, a card added from then on keeps its code, and an agent pays with it where a checkout asks, a route call too. Turning it on asks the owner first; turning it off forgets every kept code at once. `on` sets it; null only reads it. Answers whether it is on and the cards whose code it just forgot. |
| `listing_sign` | `{id, signature}` | Hands the node the owner's wallet's signature of a listing listings_to_sign names, by its id. The node takes only the wallet's own signature, never an agent key's or anyone else's, then puts the listing under a root and spreads it under the wallet's identity. Signing sends no transaction. |
| `listings_to_sign` |  | The listings this node keeps for the owner's wallet to sign. A node linked to the owner's wallet lists under the wallet's one identity, and only the wallet's own key signs a listing, never an agent key (issue #184), so a node that doesn't hold that key asks the owner to sign each one. Each is said in plain words and given as the EIP-712 typed data the wallet signs (eth_signTypedData_v4). Empty when the node lists under its own wallet. |
| `open_link` | `{link, ask_network}` | What an unbrowse:// link names: a site's routes, or one route. Calls nothing and pays nothing. A link can come from any page, so by default only this node's own routes are shown and the peer network is asked nothing; `ask_network`, sent when the owner clicks for more, also shows the routes the network lists and the chain proves. |
| `report_discard` | `{fingerprint}` | Drops an agent's waiting bug report unsent. |
| `report_send` | `{fingerprint}` | Sends an agent's waiting bug report, as it waits, to be filed as a public issue: asked in the node's own dialog, which shows the report's text. |
| `reports_waiting` |  | The bug reports agents wrote that wait for the owner: each with its fingerprint, when it was written, and what it would be filed with as a public issue. Nothing an agent writes is sent until the owner sends it. |
| `share_approve` |  | The owner has looked at the routes waiting to be shared and lets the first listing go now, rather than a day after the node told them (R2.8). |
| `terms_text` |  | The terms of service and privacy policy this node asks its owner to acknowledge, as they are written. |

---

## 7. Environment variables

Read by the node and `unb` at run time. Settings live in `~/.unbrowse/settings.json`; a variable wins over its
setting where both exist.

| Variable | What it does |
|---|---|
| `UNBROWSE_HOME` | Where the node keeps everything, instead of `~/.unbrowse`. A dev build (or a Linux node keeping its key in a file) in any other folder makes a root key of its own; only `~/.unbrowse` takes over the Keychain's |
| `UNBROWSE_ROOT_KEY_FILE` | `1` has a release build in a folder of its own (`UNBROWSE_HOME`) keep its root key in `<home>/root.key`, readable by its user alone, instead of the system's keystore. Unset, a release build's key is in the keystore, under an account of that folder's own (never the one `~/.unbrowse` uses), unless `<home>/root.key` is already there, which is always the key; a dev build's is always a file |
| `UNBROWSE_DOOR_PASS` | `1` lets the node run a refusal page's own scripts in its sandbox to earn the cookie a browser would, on a walk and on a call. Off by default: the page is a site's code, and the sandbox it runs in is not an isolate |
| `UNBROWSE_CHAIN` | The chain, over the `chain` setting: `devnet`, `arc-testnet`, `arc-mainnet` |
| `UNBROWSE_RPC` | A live network's RPC, instead of the one `app/src/arc.rs` names |
| `UNBROWSE_<NETWORK>_<USDC\|UNB\|POOL>` | A token or pool for `chain deploy` to build on, over the network file's `existing` (`UNBROWSE_ARC_MAINNET_UNB` names mainnet's UNB, which the repository's `arc-mainnet.json` doesn't; `chain::network_file`) |
| `UNBROWSE_<NETWORK>_FEE_RECIPIENT` | Who the 1% trade fee of every route coin accrues to, fixed for good by `chain deploy`; else the deploying key. A mainnet deploy refuses to go without it ([OPERATIONS.md](OPERATIONS.md)) |
| `UNBROWSE_SITE` | The site tried first for sign-in, its relay and the linked owner's events (`https://…`, no path) |
| `UNBROWSE_DEVNET_PORT` | The devnet's Anvil port (8546) |
| `UNBROWSE_DEVNET_FORK` | What a new devnet forks: `arc-testnet` by default, another network's name, or `none` |
| `UNBROWSE_DEVNET_USDC_DECIMALS` | A new devnet's test USDC decimals (18 by default; 6 counts as Arc's does) |
| `UNBROWSE_DEVNET_EPOCH_SLOTS` | Slots in an epoch of the devnet's Anvil as the node starts it (0 by default, so each block is final as it is made, as Arc's are; more puts the finalized block two epochs behind the head, for tests of reorgs) |
| `UNBROWSE_NETWORK_DIR` | The folder of node ads, instead of `~/.unbrowse-network` |
| `UNBROWSE_PEER_PORT` | The peer port, instead of the saved one ([NETWORK.md §9](NETWORK.md#9-being-reached-nat-relays-addresses-the-peer-port)) |
| `UNBROWSE_ANNOUNCE` | Comma-separated multiaddrs the node is reached at, published first |
| `UNBROWSE_PASSKEYS` | `0` or `1`, over the passkeys setting |
| `UNBROWSE_TELEMETRY` | `0` or `1`, over the telemetry file; a dev build sends only with `1` |
| `UNBROWSE_TELEMETRY_URL` | Where telemetry goes |
| `UNBROWSE_REPORTS` | `0` or `1`, over `reports.json`; reports are off whenever telemetry is, and a dev build sends only with `1` |
| `UNBROWSE_REPORTS_URL` | Where bug reports go (the relay's `/v1/reports`) |
| `UNBROWSE_REGISTRY` | The npm registry updates are read from (`https://registry.npmjs.org`) |
| `UNBROWSE_BROWSER` | The browser program to browse with, when it is there (else the one beside the node, else the one `browser install` put in `~/.unbrowse/addons/browser`) |
| `UNBROWSE_SYSTEM_BROWSERS` | `0` keeps the node off the browsers installed here: only the Chrome for Testing it downloaded |
| `UNBROWSE_PORT` | The port the agent API listens on, over the `api_port` setting (a second node on one machine; a node an SDK starts) |
| `UNBROWSE_CDP` | A DevTools address for walks to use instead of launching a browser |
| `UNBROWSE_NODE`, `UNBROWSE_AGENT_TOKEN` | `unb`'s node and agent token (§4) |
| `UNBROWSE_WRITE_AGENT_API` | `1` makes the manifest test rewrite `agent-api.json` |
| `TYPESAFE_API_KEY`, `TYPESAFE_API_BASE`, `TYPESAFE_MODEL` | The key, endpoint and model of the decision model the learner may ask (`learn.rs` `clef`, `crates/learn/src/judge.rs`); else the Keychain item `network.unbrowse.clef` |
| `UNBROWSE_WALK`, `UNBROWSE_URL`, `UNBROWSE_GOAL` | A test: learn from a recorded walk log (`learn.rs`) |
| `UNBROWSE_MINT_DEBUG`, `UNBROWSE_TLS_DEBUG`, `UNBROWSE_WIRE_DEBUG` | Debug output from the mint, the TLS stack and the wire (`crates/learn`) |
| `UNBROWSE_ALPS_OLD` | Sends ALPS under its old codepoint (`crates/learn/src/http.rs`) |

`unbrowse` reads `UNBROWSE_APP` and `UNBROWSE_BIN` to find the app and the programs (§3). An app `UNBROWSE_APP` names
runs only when its signature names the vendor's team, as an installed one does. `UNBROWSE_UNCHECKED_APP=<absolute path
of the app>` runs a build of one's own with signature checks off, and every run says so on stderr
([SECURITY.md](../SECURITY.md)).

---

## 8. Build flags

Read with `option_env!` when the node is built (`app/src/build_config.rs`, `update.rs`). A plain `cargo build` sets
none of them. The release workflow passes the first three from the repository variables of the same name; an empty
value counts as unset, and a value the node wouldn't take fails the build.

| Flag | What it sets | Unset |
|---|---|---|
| `UNBROWSE_DEFAULT_CHAIN` | the chain a fresh install runs on | `devnet` |
| `UNBROWSE_SITE` | the site tried first, after `UNBROWSE_SITE` at run time | `https://unbrowse.ai`, then `https://unbrowse.si` |
| `UNBROWSE_SHARE_DEFAULT` | the sharing mode a fresh install starts in: `used`, `all`, `off` | `used` |
| `UNBROWSE_RELEASE` | a release build: it updates itself and holds peers to the network's `min_version` | a dev build: neither |

They are defaults only: a settings file the owner already has keeps what it says. How a release sets them is
[OPERATIONS.md](OPERATIONS.md).

**Cargo features** (`unbrowse-node/app/Cargo.toml`), off by default:

| Feature | What it adds |
|---|---|
| `antithesis` | the Antithesis SDK's assertions at the places the harness can't see from outside (`app/src/antithesis.rs`, `crates/net/src/antithesis.rs`); without it each assertion is nothing |
| `antithesis-coverage` | the above, and the coverage runtime the harness's sanitizer-coverage build links against (`antithesis/Dockerfile`) |

---

## 9. How this list was made

The lists above were read from the code, then checked against it with a script that pulls each surface out of the
source and fails if this page doesn't name it:

| Surface | Read from |
|---|---|
| top-level commands | the `Some("<command>")` checks in `main()` before the node starts |
| subcommands | every `usage: unbrowse-node …` line in `main.rs`, `telemetry.rs` and `report.rs`, `WALLET_USAGE`, and `chain::names` |
| owner commands | the match arms of `pub async fn owner` in `main.rs` |
| agent API | `agent-api.json`, and every `.route("…")` in `api.rs` |
| `unb` | the `Some("<command>")` arms in `bin/unb.rs` |
| environment | every `env::var("…")`, `var_os("…")` and `env("…")` in `app/src` and `crates/*/src` |
| build flags and features | every `option_env!("…")`, and the `[features]` table of `app/Cargo.toml` |

It found 187 names, every one on this page. The script was kept outside the repository; the same reading by hand is:

```bash
cd unbrowse-node/app/src
grep -o 'Some("[a-z-]*")' main.rs | sort -u          # commands, with the match arms of each *_cli
grep -o '"usage: unbrowse-node[^"]*"' main.rs         # every usage line
sed -n '/pub async fn owner(/,/OwnerError::Unknown/p' main.rs | grep -o '^        "[a-z_]*"'
grep -o '\.route("[^"]*"' api.rs; cat ../../agent-api.json
grep -rhoE '(env::var|var_os|env)\("[A-Z_0-9]+"' . ../../crates | sort -u
grep -rhoE 'option_env!\("[A-Z_]+"' . | sort -u
```

The commands in §2 were run against a scratch `UNBROWSE_HOME` on the devnet, and their output read back into the
descriptions.
