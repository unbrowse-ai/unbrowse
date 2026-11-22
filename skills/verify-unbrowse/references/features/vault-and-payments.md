# Vault and payments

The node keeps the owner's secrets and money. The vault holds logins (derived or stored), one-time code keys, payment cards, website passkeys and per-site sessions. Agents see references such as `vault:<site>:<account>`, never a password, code or number. The node also holds a wallet on a chain (the devnet in a scratch run), pays other contributors' route fees up to a per-fetch maximum, and can hold route coins and bounties. A card checkout always waits for the owner's yes, in the window or on the owner passphrase.

## Sub-features

- `vault-login` adds, lists, rotates and removes a login by reference.
- `vault-code` keeps a one-time code key and lists a `vault:code:` reference.
- `vault-import` imports a browser's or password manager's export, with counts.
- `vault-card` adds, lists and removes a card by label and last four.
- `vault-card-codes` keeps card security codes only when the owner turns that on.
- `vault-card-limit` saves per-payment and per-day limits for a card on a site; they let nothing through.
- `checkout-hold` holds a site from agents while the owner is asked about a card, until `checkout done` or `dismiss`.
- `checkout-approval` asks the owner for each card fill and each paying route call.
- `passkey` lists, turns on or off, blocks per site, imports and removes passkeys.
- `session` lists, imports and forgets a host's session.
- `wallet` shows the node's address and the gas held.
- `chain` shows the chain, its contracts and the devnet clock.
- `money` shows the balance, what agents may spend and each agent's day.
- `max-fetch` sets the most the node pays to fetch one route.
- `coin` shows route coin holdings; `bounty` lists bounties.
- `owner-yes` asks the owner for a reveal, a key backup, a new key or a cap raise.

## How to get to it (user POV)

- CLI: `unbrowse-node vault list|add|remove|rotate|code|import`, `vault card add|codes|approver|limit|limits|remove`, `checkout [list]|done|dismiss`, `passkey ...`, `session list|import|forget`, `wallet`, `wallet address`, `chain`, `money`, `earnings`, `nodes`, `max-fetch`, `coin`, `bounty list|show`, `passphrase`, `confirm`.
- Agent: `unbrowse_logins`, `GET /v1/logins`, `unb logins`, `logins()` and `cards()` in the SDKs; a `fill` of `vault:...` references through `unbrowse_browse`.
- Owner commands (underscore names): `vault_list`, `vault_add`, `vault_cards`, `vault_card_add`, `card_limit`, `card_limits`, `keep_card_codes`, `payment_approver`, `checkout_holds`, `checkout_release`, `passkeys`, `passkey_never`, `sessions`, `import_session`, `forget_session`, `wallet`, `identity`, `funding`, `chain_status`, `money`, `earnings`, `coin_holdings`, `bounty_list`, `bounty_show`, `confirmations`, `confirm`.
- Window: Money, Vault, Agent access, Settings (see `window.md`).

## Driving it with unbrowse-verify

Preconditions:

- A scratch node is healthy on the devnet with no fork. The vault and wallet are the scratch home's own.
- No real card or password is used. Test values only, and they are removed at the end.

- **Add a login.** Run `unbrowse-verify node -- vault add example.test me`. Then `unbrowse-verify node -- vault list`. It shows `vault:example.test:me` and its kind, never a password.
- **Agent view.** Run `unbrowse-verify api GET /v1/logins`. The login is a reference with no secret. Run `unbrowse-verify owner vault_list` for the owner's view.
- **Rotate and remove.** Run `unbrowse-verify node -- vault rotate example.test me`, then `vault remove example.test me`. `vault list` no longer shows it.
- **Add a card.** Run `printf '4242424242424242\n12/30\nTest Card\n' | unbrowse-verify node -- vault card add testcard`. `vault list` shows `vault:card:testcard:<field>` refs. `unbrowse-verify api GET /v1/logins` shows the label and last four `4242` only.
- **Card codes default.** Run `unbrowse-verify node -- vault card codes`. It reports off.
- **Card limit refusal.** Run `unbrowse-verify node -- vault card limits`. It lists limits and what went out today (nothing). Saving one asks the owner (see Gotchas).
- **Checkout holds.** Run `unbrowse-verify node -- checkout list`. It says no checkout is held. Run `unbrowse-verify owner checkout_holds` for the same.
- **Passkeys.** Run `unbrowse-verify node -- passkey list` and `unbrowse-verify owner passkeys`. The list is empty and shows whether passkeys are on. Run `unbrowse-verify node -- passkey never example.test` then `passkey allow example.test`. `owner passkeys` shows the site blocked, then allowed.
- **Sessions.** Run `unbrowse-verify node -- session list`. It lists hosts and cookie counts, no value. Run `unbrowse-verify owner sessions` for the same.
- **Wallet.** Run `unbrowse-verify node -- wallet address`. One address alone. Run `unbrowse-verify node -- wallet` for the network (`devnet`) and gas held.
- **Chain.** Run `unbrowse-verify owner chain_status`. It names the devnet and its contracts.
- **Money.** Run `unbrowse-verify owner money`. Balance and `needed_to_start` are decimal dollar strings. Run `unbrowse-verify owner agents_spend` for each agent's day.
- **Max fetch.** Run `unbrowse-verify node -- max-fetch 0`, then `unbrowse-verify owner settings`. `max_fetch_usdc` is 0. Restore with `max-fetch 0.05`.
- **Coins and bounties.** Run `unbrowse-verify node -- coin` and `unbrowse-verify node -- bounty list`. Both are empty.
- **Card approval asked.** Not driven on a scratch node: it needs a checkout page, and a live merchant's is never used for a check. Run `unbrowse-verify owner confirmations` and see no question waits. Report the approval journey as not proven, with this reason.
- **Cleanup.** Run `unbrowse-verify node -- vault card remove testcard` and remove any login added.

## Gotchas

- No real card, payment or message. Card journeys stop at what is observable: the card listed by label, the refusal, the approval being asked.
- The owner's yes (`vault_reveal`, `wallet_phrase`, `wallet_export`, `wallet_restore`, `wallet_import`, `agent_set_cap`, `agent_create`, `link_wallet`, `wallet_send`, a card fill, `vault card limit`, spending settings) cannot be given on the scratch node. The call waits or is refused. The honest outcome is "asked, not answered". Do not weaken the journey, and do not answer for the owner.
- The node's `checkout done` and `dismiss` end a hold. Only the owner ends one. Do not run them for a hold you did not see asked.
- Devnet with no fork has no real USDC, no gas market and no other nodes. Fees, payments between nodes, coins, bounties, stakes, deposits and claims need a credited entry and a peer. They are not proven here. Say so.
- `faucet` and `advance_day` exist on the devnet only. The faucet's amount units are not documented here, so it is not driven.
- With the peer network off and sharing off, `how: network` and paid fetches never happen. Max-fetch is proven by its stored value only.
- `vault import`, `session import` and `passkey import` read a file of secrets. Use a throwaway file with fake values, then delete it.
- Passkeys are on by default, and a site may get one with no owner step. Do not enrol on a real site.
- `vault add --stored` and `vault card add` read stdin. If the harness cannot pass it, report the path as unreachable.
- Never print a token, cookie, number or password into evidence.
