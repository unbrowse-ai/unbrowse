# Troubleshooting

Symptom first, then why, then what to do. Every entry here came from a real failure.

The node's messages go to its standard error: the terminal you started `unbrowse-node` in, or your service manager's
log (for a systemd user service, `journalctl --user -u <unit>`). The window logs to its own standard error.

- [The window or an agent says "the owner's token only"](#the-window-or-an-agent-says-the-owners-token-only)
- ["this needs the node's browser" (`browser_missing`)](#this-needs-the-nodes-browser-browser_missing)
- ["<site>'s browser was busy for 90 s with ..."](#sites-browser-was-busy-for-90-s-with-)
- [The node logs "port 7788: Address already in use"](#the-node-logs-port-7788-address-already-in-use)
- ["the stored root key is unreadable"](#the-stored-root-key-is-unreadable)
- [The window crashes when importing passwords (Linux)](#the-window-crashes-when-importing-passwords-linux)
- [The window doesn't open (Linux)](#the-window-doesnt-open-linux)
- [The recovery phrase gives a different address in MetaMask](#the-recovery-phrase-gives-a-different-address-in-metamask)
- ["Settlement isn't deployed on arc-testnet yet"](#settlement-isnt-deployed-on-arc-testnet-yet)
- ["couldn't join the peer network ... 0 USDC for gas"](#couldnt-join-the-peer-network--0-usdc-for-gas)
- [`npm install -g unbrowse` installs an old version](#npm-install--g-unbrowse-installs-an-old-version)
- [`unb` says the node "took the request but hadn't answered after 330 s"](#unb-says-the-node-took-the-request-but-hadnt-answered-after-330-s)

Fixes marked "fixed on `main`" ship in the first release after the change; until then, build from source
([README](../README.md#run-from-source)) or use the workaround given.

---

## The window or an agent says "the owner's token only"

**Why.** The node makes a fresh owner token every time it starts and keeps it in `~/.unbrowse/owner.token`; the window
reads it from there. If **two nodes** run at once, the file can hold a token the node actually answering on port 7788
doesn't have. The usual cause is a supervisor (a systemd unit with `Restart=on-failure`, a launch agent) starting a
second node while one is already serving, or the window starting one while a service runs another.

**Check.**

```bash
pgrep -ax unbrowse-node          # more than one line: more than one node
ss -ltnp | grep 7788             # (Linux) which process holds the port; macOS: lsof -iTCP:7788 -sTCP:LISTEN
```

**Fix.** Stop every node, then start exactly one — the app, `unbrowse-node` (or `unbrowse start` from the npm
package), or your service, not several:

```bash
pkill -x unbrowse-node           # stops all of them
unbrowse-node                    # or open the app, or start your service
```

Fixed on `main` (#56): a node that can't take the port no longer touches the running node's token.

## "this needs the node's browser" (`browser_missing`)

The goal needs a browser (to learn a page, or to drive one) and the node has none, or the call said `browser: never`.
Everything else works without it. Run `unbrowse browser install` on the node's machine, or `unbrowse browser fetch on`
to let the node fetch it the first time a goal needs it; `unbrowse browser status` says what it lacks. `browser:
installing` means it is fetching it now: try again in a minute. See [guides/the-browser.md](guides/the-browser.md).

## "<site>'s browser was busy for 90 s with ..."

**Why.** A site's browser runs one command at a time, and a command waits up to 90 s for its turn. The message names
what held it and for how long: an agent's command (`open` for agent 0), the node healing a route, or a browser waiting
for the node's own walk of a page to give the site's profile back. The node's log has a line for every refusal and
every turn held 60 s or more (`browser: ... held <site>'s browser for N s`).

**Fix.** Wait for the holder the message names to end, then try again. Before this was fixed (issue #545), a browser
command waited for the browser program's output pipes to close rather than for the program to exit. On Windows the
browser's daemon can inherit those pipes, so the first command that started a site's browser (a `do` opening a page that
needs hands, or `unb browse open`) could hold the site's browser until the daemon exited. A browser command now ends
when the program does, and is stopped after 180 s plus any time it asked for itself.

## The node logs "port 7788: Address already in use"

**Why.** Another node — often an older one still running — already serves `127.0.0.1:7788`. The new one exits; a
supervisor may restart it every few seconds (watch for a climbing restart counter). A window from before the fix
started its own node whenever the one it watched went away, so restarting a service left the window's node holding the
port: it logs to `~/.unbrowse/node.log` (a service's node logs to the journal), and its parent is the service manager
(`ps -o ppid`), not the service (`systemctl --user status` doesn't list it).

**Fix.** As above: `pgrep -ax unbrowse-node`, stop the extra ones, keep one. To run two nodes on purpose (testing),
give each its own `UNBROWSE_HOME` and port.

## "the stored root key is unreadable"

**Why.** The node keeps its root key in the OS keystore — the Keychain, Windows' Credential Manager, or the Secret
Service on Linux. Some Linux keyrings *accept* a secret and hand back different bytes, so the node writes a key it can
never read again. Everything made from it — the wallet, agent keys, the vault's sealed secrets, the recovery phrase —
is then out of reach.

**New installs: fixed on `main` (#51).** On first start the node checks that the keystore gives back exactly what it
stored; when it doesn't, the key is kept in `~/.unbrowse/root.key` (readable by you alone) instead.

**An install that already hit it.** The key in the keyring can't be recovered from the keyring.

- **If you saved the recovery phrase (12 or 24 words):** back up `~/.unbrowse`, then restore —
  `unbrowse-node wallet restore` and paste the words (they're read from standard input, never from the command line).
- **If you exported an encrypted backup:** `unbrowse-node wallet import <file>`, with the node stopped, and type its
  passphrase.
- **If you didn't:** the old key is gone. Back up `~/.unbrowse` (`cp -a ~/.unbrowse ~/.unbrowse.bak`), remove the
  keyring entry (service `network.unbrowse.node`, username `root-key`: `secret-tool clear service
  network.unbrowse.node username root-key`), and start fresh. Logins imported into the old vault were sealed under the old key; import them again from
  your password export.

Save the new recovery phrase (window: Wallet, Show recovery phrase) somewhere off the machine.

## The window crashes when importing passwords (Linux)

**Symptom.** Vault → Import passwords → choosing the file closes the window; its log shows
`panic: reached unreachable code` in `screens/vault.zig`.

**Why.** The file chooser was opened from inside a frame; on Linux it runs a nested GTK loop that re-enters drawing.

**Fixed on `main` (#52).** The import itself usually finished before the crash — check the Vault. Until the fix ships,
import from a shell; nothing is lost:

```bash
unbrowse vault import ~/Downloads/passwords.csv   # or: unbrowse-node vault import <file>
```

Then delete the export: it holds every password in plain text.

## The window doesn't open (Linux)

The native window needs GTK 4 (or GTK 3). Check that it's running and read its output:

```bash
pgrep -ax unbrowse-window
unbrowse-window                  # run in a terminal to see why it stops
```

`Gtk-WARNING ... Unknown key gtk-modules in ~/.config/gtk-4.0/settings.ini` is harmless. If the process is running
but nothing shows, it may be on another workspace. Closing the window leaves the node running.

## The recovery phrase gives a different address in MetaMask

**Only for a node made before seed words: 24 words.** A node made now shows 12 seed words, and its key is made from
them at the standard path (`m/44'/60'/0'/0/0`), so MetaMask, Rabby or any EVM wallet opens the same address with them.

An older node's key wasn't made from seed words, and it keeps that key: its address is its identity on chain. Its 24
words are the key written straight out as BIP-39 *entropy*. Other wallets treat any phrase as *seed words*, hash it
and derive a key along that path, so they arrive at a different key. The 24 words restore the key into an Unbrowse
node (`unbrowse-node wallet restore`); they don't import into other wallets.

To open an older node's wallet elsewhere, export its key (`unbrowse-node wallet export <file>`, or Settings, Security
in the window): an encrypted Ethereum keystore file that any wallet importing one opens. Whoever holds it and its
passphrase controls the wallet: treat it like the phrase.

## "Settlement isn't deployed on arc-testnet yet"

**Why.** The node runs on a live network (a release runs on Arc testnet; `chain` in Settings, or `UNBROWSE_CHAIN`, can
name another) whose network file names no Settlement contract yet, so payments aren't open there: the windows say
"Payments aren't open on this network yet". Routes, browsing, the vault and your own agents' calls still work; paid
routes from other contributors and earnings wait.

**Fix.** Nothing to do on your side: the node reads the network file again by itself and takes Settlement once a
release names it (`unbrowse-node chain` shows what it reads). Whoever runs the network deploys it with `unbrowse-node
chain deploy` ([OPERATIONS.md](OPERATIONS.md)). To try payments now with test money, run a node on the local devnet:
set `chain` to `devnet` in Settings (or `UNBROWSE_CHAIN=devnet`) with Foundry's Anvil installed; the node then runs
Anvil in `~/.unbrowse/devnet` and deploys the contracts itself. A devnet's balances are test money and stay there.

## "couldn't join the peer network ... 0 USDC for gas"

**Why.** On a live Arc network registering the node's identity is a write, and the node's key holds no gas to pay for
it. There is no sponsor (spec §76): every write is the node's own.

**Fix.** Send a few cents of USDC to the node's address, or accept the sign-in page's offer to send it from your own
wallet ([ONBOARDING.md](ONBOARDING.md#3-paying-your-own-way)). The node joins by itself once it can pay, with no
restart. To send it by hand, use the node's address (`unbrowse-node wallet address --copy`): on Arc testnet it is free from Circle's faucet,
https://faucet.circle.com. The node keeps trying to join meanwhile, and works without the peer network; it only won't
find other nodes' routes.

## `npm install -g unbrowse` installs an old version

**Why.** The current releases aren't on npm yet: npm still serves the older `unbrowse` package.

**Fix.** Install from the [latest release](https://github.com/unbrowse-ai/unbrowse/releases): the macOS app, or
the `unbrowse-<version>-<os>-<arch>` download for your machine, whose README says how to start it.

## `unb` says the node "took the request but hadn't answered after 330 s"

**Why.** `unb` waits 330 s for an answer (the node's `call_wait_secs`, as the SDKs do). A `do` that walks a page, or
walks it again to learn, can take longer, and the node has no deadline of its own: when `unb` stops waiting, the work
carries on on the node. Before this message (issue #544), `unb` said "couldn't reach the node ... Is the Unbrowse app
running?" for this too, though the node was up.

**Fix.** Nothing to restart: the node is running. Ask again once the work has ended. "Couldn't reach the node ...
Is the Unbrowse app running?" now means the connection itself failed, and "answered ..., but not with JSON" means
something other than the node answers at `UNBROWSE_NODE`.
