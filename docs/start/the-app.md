# The app

`unbrowse app` opens a window onto the node on this machine. The window talks to the node over `127.0.0.1` with the
owner's token (`/owner/*`, [CLI.md §6](../CLI.md#6-owner-commands)), starts the node when nothing answers, and leaves
it running when it closes: agents keep working without it.

The window is native on every platform: `unbrowse-node/window`, Zig on nanoui.

## The screens

The sidebar, in order (`window/src/app.zig` `screen_labels`); ⌘1 to ⌘9 and ⌘0 open them in that order (Ctrl off a Mac),
⌘F finds a route on My routes, and ⌘R reads everything from the node again:

| Screen | What it holds | Code |
|---|---|---|
| **Node** | The node at a glance: its city (each site a building, each route a door, a light from the agent to the door on each call), what it earned, the agent's eye on the current walk, what it does and what it learned while you browsed. Until the node can pay its own way, how much to add to start it ([ONBOARDING.md §3](../ONBOARDING.md#3-paying-your-own-way)) | `screens/overview.zig`, `city.zig`, `eye.zig` |
| **Live** | A walk as it happens: the browser's pictures, the calls weighed against the goal and the one kept, with what picked it; a heal's re-walk too | `screens/live.zig`, `kept.zig` |
| **Browser** | The node's browsers, one per site agents use. Click and type on the live picture to sign in, enter a code or pass a check | `screens/hands.zig` |
| **My routes** | Every route this node knows, with its inputs, last call and standing (`Not listed`, `Listed, held here`, …). Try one, list one, delete one | `screens/routes.zig` |
| **Money** | Your **Balance**, one number in dollars, with **Add funds**, or "Add $X to start" while it is too low to start; what agents spent today, in a line, with **Agent keys** to manage them; earnings as **Ready to take**, with **Cash out**, which takes all of it to this node's wallet. Network fees come out of the same balance. In test mode, Add test funds sits beside Add funds. **Advanced**: where the balance sits, what was earned by day and from where (from staking route coins, and as contributor), your route coins (staked, asked back, earned and parked), your fee, the deposit and withdrawing it, the node's address and your linked account; in a dev build, Advance a day. The backup key and restoring from it are in Settings, Security | `screens/wallet.zig` |
| **Vault** | Logins (add, rotate, remove, a one-time code key, import passwords) and the live sessions on this node (import a site's session, forget one) | `screens/vault.zig` |
| **Agent access** | The agent keys: each one's daily limit and what it spent today, **Add agent** and **Revoke**; and how an agent connects, with example requests to copy | `screens/access.zig`, `wallet.zig` `keys` |
| **Activity** | Every call, walk and payment, with its result and its reference. Export it as CSV | `screens/activity.zig` |
| **Leaderboard** | Contributors ranked by the paid fetches their routes served, counted from the network's listings and the usage it collected | `screens/board.zig` |
| **Settings** | Pause, map while browsing, the peer network, private networks, serving routes for others, updates, the API port, sharing, the per-fetch maximum, the linked wallet, the backup key, the browser, excluded sites. Each control saves itself ([node-settings.md](../reference/node-settings.md)) | `screens/settings.zig` |

The window asks first: the node holds off the network until its owner has seen the current terms and chosen whether
to keep it off (`screens/first_run.zig`). The window shows the terms themselves, as the node carries them; looking at
the screen records nothing. There is no sign-in: the node uses its own wallet (spec §86).

## What the node asks you

Agents never wait for you over a fee: the node pays another contributor's fee itself, up to the per-fetch maximum,
and each agent key stays within its daily limit (`agents.rs`, `api.rs` `call_entry`). A card is the exception: the
first fill on a checkout page waits for you to approve paying with that card there (one approval covers that card's
fields on that page, bound to the page's form as you saw it), and every route call that pays by card waits for you (`api/browse.rs` `approve_checkout`,
`api/call.rs` `approve_route_payment`). From the moment you're asked about a card on a site until you say
the checkout is finished or dismissed, agents can't act on that site or any host the checkout names, and no route reaches
them; closing the tab doesn't end it. The agent asks you to submit the payment: you check the order on the live page
(the node can't vouch for the amount it shows), pay, and press Done, or dismiss the checkout in the window or with
`unbrowse-node checkout dismiss <site>`. A site you give a card to can charge it; the node's promise is that the agent
can't change or send the order. The window brings itself forward only when an
agent asks for your hands (`api/browse.rs` `ask_owner`, `hands.rs`):

A check the agent can see for itself — a checkbox, an image grid, a slider, a queued page — never brings your window
forward: `unbrowse_challenge` shows the agent a picture of the page, and the node takes its clicks one step at a time.

| What | When | How long it waits |
|---|---|---|
| A page only you can pass | an agent's `ask_owner` (a sign-in the vault has no login for, a two-step code, a check that wants a person): the page shows on Browser | 5 minutes (`hands::ASK_WAIT`), or the agent's `--timeout` up to 1800 seconds |
| A payment with a vault card | the first card fill on a checkout, and every route call that pays by card: the window shows the card, the site, and for a route what it does and sends | 5 minutes (`hands::ASK_WAIT`); no answer fills nothing |

What you type on a page you take is never shown to the agent ([unbrowse-node/README.md](../../unbrowse-node/README.md#the-owners-hands-on-a-page)).

Next: [Connect your agent](../guides/connect-your-agent.md).
