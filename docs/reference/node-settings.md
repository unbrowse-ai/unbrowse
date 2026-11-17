# Node settings

The node's settings live in `~/.unbrowse/settings.json`: the `Settings` struct in `unbrowse-node/app/src/store.rs`,
with its defaults in `impl Default for Settings`. The window's **Settings** screen changes them (each control saves
itself, through the `save_settings` owner command), and so do the commands below. A running node reads most of them
again on every pass; the table says which wait for the next start. A field an older file lacks reads its default.

| Field | Default | What it does | Set by |
|---|---|---|---|
| `paused` | `false` | Agents' calls, browsing and asks get HTTP 503, "the node is paused by its owner"; the node lists nothing by itself | Settings, Paused |
| `map_while_browsing` | `true` | Walks can be kept as routes. Off: browsing teaches nothing, and `unbrowse_do` with no route is refused (`api/goal.rs` `do_goal`) | Settings, Map while browsing |
| `peer_network` | `true` | Advertise the node and find other nodes' routes. Off: from the next start, the node keeps to itself ([NETWORK.md §10](../NETWORK.md#10-opting-out)) | Settings, Join the peer network; the first-run screen; `network on\|off` |
| `light` | `false` | Light mode: on the peer network the node only asks, and seeds no body it fetched ([NETWORK.md §8](../NETWORK.md#8-seeding-light-mode-and-the-dark-set)) | `network light\|full`, next start |
| `private_network` | `false` | Let the node's calls follow a public name to an address inside this network, for an intranet. Off: such a name is refused before anything is sent (`crates/learn/src/egress.rs`) | Settings, Reach private networks |
| `hold_routes` | `false` | Hold and serve other nodes' routes (`peers.rs` `hold_tick`). Nothing is paid for serving; a contributor's node that serves a passed, counting line of its own entry is checked on it | Settings, Serve routes for others |
| `storage_gb` | `4` | The bound on routes held for others (`peers::max_held`) | no control |
| `auto_update` | `true` | Fetch newer releases and restart into them, in a release build ([updates.md](../guides/updates.md)) | Settings, Keep up to date |
| `api_port` | `7788` | The port agents and the window reach the node on, on `127.0.0.1`. Next start | Settings, Agent API port |
| `excluded` | `[]` | Sites the node never learns from, calls or heals ([unbrowse-a-site.md](../guides/unbrowse-a-site.md#keeping-a-site-out)) | Settings, Mapping |
| `share_routes` | `used` (the build's `UNBROWSE_SHARE_DEFAULT`) | Which routes the node lists by itself: `used`, `all` or `off` (`autolist.rs`). An old file's `true` reads `used`, `false` reads `off` | Settings, Share routes I learn; `share used\|all\|off` |
| `list_per_day` | unset: 5 for `used`, 20 for `all` | The most routes the node lists by itself in a day. Listing costs no gas (a signed listing under the reserve's root), so this paces what is shared, not what is spent | Settings, Most routes listed in a day; `share per-day <n>` |
| `share_notice_seen` | `false` | Whether the owner was told once that the node shares what it learns | the window |
| `max_fetch_usdc` | `0.05` | The most the node pays, in USDC, to fetch one route another contributor lists. Agents spend up to it with nothing to approve; a route over it is passed over. `0`: free and own routes only. A value that isn't a sum of money pays nothing | Settings, Paying for routes; `max-fetch <usdc>` |
| `coin_dev_buy_bps` | `100` | The listing's first buy (`coin_dev_buy`, `decide.dev-buy-default-on`): when an entry of this wallet's is credited, the node launches its route coin with this share of the wallet's UNB at that moment, in basis points, and stakes the coins for the owner. `100` is 1%; `0`: off. A wallet with no UNB launches nothing, and the route still lists. Raising it past the default asks the owner in the node's own dialog |
| `coin_complete_others` | `false` | Whether the claim pass also completes other wallets' held coin buys (`CoinFetch.completeBuy`), paying their gas. Off: the node completes only its own owner's | settings file |
| `bounty_auto` | `false` | Whether the node takes the bounty steps for the owner: asking the owner's agent whether an entry answers an open bounty, confirming on the agent's yes and the owner's own, and releasing by use the shares of entries the owner lists. On or off, the owner's bounties past their deadline are settled and refunded | `unbrowse-node bounty auto on` |
| `deposit_floor_usdc` | `0.5` | On a live chain, USDC in the node's wallet moves into the deposit until it reaches this (`chain::top_up`). `0`: never | settings file |
| `gas_reserve_usdc` | `0.25` | Where USDC is also the gas, what a top-up leaves in the wallet; never less than a claim batch takes | no control |
| `claim_gas_share` | `0.1` | The node claims a batch by itself once its gas is at most this share of what it pays (`chain::claim_due`) | no control |
| `chain` | a new file: the build's `UNBROWSE_DEFAULT_CHAIN`, else `devnet`; a file without the field reads `devnet` | `devnet` or an Arc network's name. Next start. `UNBROWSE_CHAIN` wins over it | `chain <name>` |
| `terms_accepted` | none | The TERMS.md and PRIVACY.md version the owner acknowledged. The node joins the network only with the current one here, and `save_settings` never changes it | The first-run screen (`accept_terms`); `terms accept` |
| `passkeys` | `true` | Keep website passkeys and sign in with them (`passkey.rs`). `UNBROWSE_PASSKEYS` wins over it | `passkey on\|off` |
| `passkeys_never` | `[]` | Sites never to enrol a passkey on or sign in to with one | `passkey never\|allow <site>` |
| `signed_in_calls` | `true` | Nothing reads it | no control |

`save_settings` refuses a per-fetch maximum, deposit floor or gas reserve that isn't a sum of USDC, zero or more, and
a claim gas share that isn't a number, zero or more (`main.rs` `save_settings`). The commands are in
[CLI.md §2](../CLI.md#2-unbrowse-node-commands).

## Kept in their own files

| File | What it holds | Set by |
|---|---|---|
| `browser.json` | the browser the owner chose to walk and browse in; a new choice applies to the next browser the node starts (`browsers.rs`) | Settings, Browser |
| `pricing.json` | the node's fee moving with demand, between a floor (0.0001) and a ceiling (1 USDC), on by default (`store::Pricing`) | Wallet, your price (`set_pricing`) |
| `telemetry.json` | the anonymous usage counts, on or off, and the install id (`telemetry.rs`) | `telemetry on\|off` |
| `reports.json` | bug reports on or off; `reports-state.json` and `reports-queue.json` hold today's counts and what waits to be sent; `reports-waiting.json` holds agents' reports until the owner sends or drops them (`report.rs`) | `reports on\|off` |

There is no telemetry or bug-report switch in the window. What telemetry sends: the root
[README](../../README.md#usage-telemetry); what a bug report holds: [Bug reports](../../README.md#bug-reports).

## Environment

A variable wins over its setting where both exist. The ones an owner meets:

| Variable | What it does |
|---|---|
| `UNBROWSE_HOME` | where the node keeps everything, instead of `~/.unbrowse` |
| `UNBROWSE_CHAIN` | the chain, over `chain` |
| `UNBROWSE_PASSKEYS` | `0` or `1`, over `passkeys` |
| `UNBROWSE_TELEMETRY` | `0` or `1`, over `telemetry.json` |
| `UNBROWSE_REPORTS` | `0` or `1`, over `reports.json`; off whenever telemetry is |
| `UNBROWSE_BROWSER` | the browser to walk and browse in |
| `UNBROWSE_REGISTRY` | the registry updates are read from |
| `UNBROWSE_NODE`, `UNBROWSE_AGENT_TOKEN` | where `unb` and the SDKs reach the node, and the agent's token |
| `UNBROWSE_BIN`, `UNBROWSE_APP` | where `unbrowse` finds the programs or the Mac app (an app named runs only when signed by the vendor's team) |
| `UNBROWSE_UNCHECKED_APP` | the absolute path of a Mac app to run with signature checks off (a build of one's own); every run warns |

Every variable, and the build flags behind the defaults: [CLI.md §7 and §8](../CLI.md#7-environment-variables).
