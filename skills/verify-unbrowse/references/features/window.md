# Window

The Unbrowse window is the native app (Zig, GTK 4 on Linux) the owner uses to watch and steer the node. It starts the node when none answers, and leaves it running when it closes. It shows the first-run terms, the node, the live walk, the owner's browser for a page that needs a person, routes, money, the vault, agent keys, activity, the leaderboard and settings. It is also where the owner says yes to a dialog (a card checkout, a new key, a password reveal). Agents never need it.

## Sub-features

- `window-first-run` shows the terms and the choice to keep the node off the network before anything else.
- `window-node` is the Node screen: the node, its routes, sites and agent spend.
- `window-live` shows a walk's latest picture (the Live screen).
- `window-browser` is the Browser screen: the owner takes a page by click and key, then gives it back (`hands`).
- `window-routes` is My routes: routes with their listing and fee, run, list, move and delete.
- `window-money` is the Money screen: balance, agent keys, earnings, coins, deposit and faucet moves.
- `window-vault` is the Vault: logins, cards and card limits, session import, one-time code keys.
- `window-access` is Agent access: make, cap and revoke agent keys.
- `window-activity` lists what happened on the node.
- `window-board` is the Leaderboard.
- `window-settings` holds the per-fetch maximum, browser choice, updates and linking.
- `window-data-parity` shows what each screen reads equals what the owner commands answer.
- `window-types-test` holds the window's views to the node's types (`zig build test`).

## How to get to it (user POV)

- Run `unbrowse app`. The window starts the node when none answers.
- Open the Unbrowse app from the desktop or the Dock.
- Build from source: `zig build run` in `unbrowse-node/window` (Zig 0.17; `zig build app` for the bundle).
- Choose a screen from the sidebar: Node, Live, Browser, My routes, Money, Vault, Agent access, Activity, Leaderboard, Settings.
- The window talks to `/owner/*` with the owner's token, and reads `GET /owner/events` and `GET /owner/frame?walk=`.

## Driving it with unbrowse-verify

Preconditions:

- A scratch node is healthy. It is headless and refuses a headed window, so the window itself is not opened.
- The owner token is in the scratch home. `unbrowse-verify owner` sends it.

The window reads these owner commands per screen. Each recipe proves the data the screen would show.

- **Node.** Run `unbrowse-verify owner node_info`, `owner identity`, `owner chain_status`, then `owner routes`, `owner sites`, `owner agents_spend`. `node_info` names the version and port, `identity` the node's address.
- **Routes.** Run `unbrowse-verify owner routes`, `owner routes_on_chain` and `owner share_status`. Each kept route is listed with its steps and listing state.
- **Money.** Run `unbrowse-verify owner money` and `owner wallet`. Balances are decimal dollar strings. Run `unbrowse-verify owner earnings` and `owner coin_holdings`. Earnings and holdings are empty or zero on a fresh node.
- **Vault.** Run `unbrowse-verify owner vault_list`, `owner vault_cards`, `owner card_limits` and `owner sessions`. References and counts only.
- **Access.** Run `unbrowse-verify owner agents_list`. The node's own key is listed, with its cap and expiry.
- **Activity.** Run `unbrowse-verify owner activity --body '{"limit":20}'`. The latest lines are first, and include any `do` you ran.
- **Leaderboard.** Run `unbrowse-verify owner board` and `owner entries`. Both are empty without a chain history.
- **Settings.** Run `unbrowse-verify owner settings`, `owner browsers` and `owner update_status`. Settings carry `max_fetch_usdc` and `headless_only`.
- **Browser hands.** Run `unbrowse-verify owner hands`. It lists sites whose browsers the owner can take and the agents' asks waiting on them. Empty is the baseline.
- **Events.** Run `unbrowse-verify logs --lines 40`. The log shows the node's own lines. The owner event stream is not read by the harness.
- **First run.** Run `unbrowse-verify node -- terms`. It reports the terms version and whether they are acknowledged. This is the state the first-run screen shows.
- **Types test.** If Zig 0.17 is installed, run `zig build test` in `unbrowse-node/window`. It fails naming the field when a view parts from `agent-api.json`. Record it as a build step.

## Gotchas

- No window, no screenshot. The scratch node is headless and its guard refuses a headed window. Every screen's look, click and dialog is not proven here. Report the window features as "data proven, screen not proven".
- Do not open the real window against port 7788. It would drive the owner's node.
- A dialog (card checkout, new key, password reveal, wallet phrase, cap raise, wallet link) needs the owner's yes. On a node with no screen the question waits for the owner passphrase (`unbrowse-node confirm`). The harness has no owner. The honest outcome is that the question is asked and waits, then times out or is refused. Do not answer it.
- `hands_input`, `hands_watch` and `hands_give_back` need a page held by the owner. They cannot be proven without a window.
- `owner hands_watch` starts picture frames. Do not use it without a window to read them.
- The window's types (`wire.zig`) are generated. Never edit them. A mismatch is a build error, not a blank screen.
- `zig build` and `zig build app` write build output into the checkout. Do not run them unless the run is allowed to build.
- Owner commands that change money, keys or the vault are in `vault-and-payments.md`. Do not run them from here.
