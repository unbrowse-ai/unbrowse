# Unbrowse node

The node on your machine. An agent says what it wants from a website; the node calls the route that does it, or
learns one from the page and calls that. Routes, logins, sessions and keys stay on this machine.

It runs headless. The window watches, approves card checkouts, handles the money
and lets the owner use a page the node's browser has open (below); closing it leaves the node working for agents.

This README is the node's entry point. The rest is in [`docs/`](../docs/README.md):

| | |
|---|---|
| Every command, owner command, agent primitive, environment variable and build flag | [CLI.md](../docs/CLI.md) |
| A new owner from install to first earnings: the address, the sign-in, paying its own way | [ONBOARDING.md](../docs/ONBOARDING.md) |
| The peer network | [NETWORK.md](../docs/NETWORK.md) |
| Sharing routes: bodies, listings, automatic sharing, fetching and paying | [SHARING.md](../docs/SHARING.md) |
| What every write costs and where a fee goes | [MONEY.md](../docs/MONEY.md) |
| Releases, networks, the landing site, running a node as a service | [OPERATIONS.md](../docs/OPERATIONS.md) |
| Every test suite | [TESTING.md](../docs/TESTING.md) |
| The whole system | [ARCHITECTURE.md](../docs/ARCHITECTURE.md) |

## What's here

| Path | What it is |
|---|---|
| [`app/`](app) | The node itself (`unbrowse-node`) and its shell client (`unb`): the agent API, browsing, the vault, running routes, the chain |
| [`crates/core/`](crates/core) | Keys: the root key in the Keychain, agent keys derived from it, the vault key |
| [`crates/learn/`](crates/learn) | The learner: walk a page, trace every value to its source, build and replay the route |
| [`crates/net/`](crates/net) | The peer network: a Kademlia table keyed by site, who may enter it, where each node sits in it |
| [`crates/files/`](crates/files) | The format of every file the node writes: its version, and the steps that read an older one forward |
| [`crates/detector/`](crates/detector) | The pinned credential detector (`unbrowse-detector/1`, R6.36): run before listing and on every fetched body; its patterns and measured false-positive rates are in its README |
| [`window/`](window) | The native window, in Zig on [nanoui](https://github.com/justrach/nanoui) |
| [`scripts/`](scripts) | The TLS patch and macOS dev signing |

## Build and run

macOS, Linux and Windows. The root key lives in the system's keystore: the Keychain, Windows' Credential Manager, or
the Secret Service on Linux (on a Linux machine with no desktop session, `~/.unbrowse/root.key`, readable by its user
alone). You need Rust and [Foundry](https://getfoundry.sh) (`~/.foundry/bin/anvil`: the node runs a local chain for
payments). The node walks and browses in a Chromium browser (`app/src/browsers.rs`): the one the owner picked in
Settings, else the Chrome for Testing it downloaded, else Chrome, else any Chromium browser installed here. With none,
it downloads Chrome for Testing when it starts. The window is native everywhere.

```bash
sh scripts/apply-tls-patch.sh            # once: vendor BoringSSL with Chrome's ClientHello extensions
sh scripts/dev-identity.sh               # optional, once: signs dev builds so Keychain access survives rebuilds
cargo build --release --manifest-path ../unbrowse-browser/cli/Cargo.toml   # the browser the node drives
cargo run --bin unbrowse-node
```

The node listens on `127.0.0.1:7788` and keeps everything under `~/.unbrowse` (`UNBROWSE_HOME` moves it). The first
start creates the root key and asks the Keychain for access.

From a shell, without the window (the programs are `target/release/unbrowse-node` and `target/release/unb` after the
build above; a release install has them on `PATH`):

```bash
unbrowse-node agent new my-agent        # an agent key; prints its setup once
unbrowse-node vault list                # logins, by reference
unbrowse-node vault import export.csv   # a browser's or password manager's export
unbrowse-node session import github.com # keep your browser's session for one site as the node's
unbrowse-node passkey list              # website passkeys (on by default; `passkey off`)
unb connect                             # register agent 0 with Claude Code
```

Installed from npm or PyPI, the same commands are `unbrowse vault …`, `unbrowse session …`, `unbrowse passkey …` and
`unbrowse agent …`. Every command, and what it prints: [CLI.md](../docs/CLI.md).

### Leaked credentials

The node needs nothing extra to find leaked credentials: the detector is a plain crate, so a node refuses to list a
body it flags, refuses to run or pay for a fetched one, and acts on takedowns. There is no leak prover and no court any
more: a leak is refused where it is found, not proven on chain.

Three values are fixed when the node is built (`app/src/build_config.rs`): the chain a fresh install runs on
(`UNBROWSE_DEFAULT_CHAIN`), the site it signs in through (`UNBROWSE_SITE`) and which routes it shares by itself
(`UNBROWSE_SHARE_DEFAULT`). A plain `cargo build` sets none of them: [CLI.md §8](../docs/CLI.md#8-build-flags).

## Imports, from the window or a shell

Everything the window's Vault imports, a shell imports too, with no window open and no node running: on a server,
over SSH, or from a script. Each import prints counts and references (`vault:<site>:<account>`, a passkey's short
name), never a password, a cookie value or a key. Delete the export once it's in: it holds every secret in plain text.

```bash
unbrowse-node vault import export.csv                       # passwords: a browser's or password manager's CSV
unbrowse-node vault import bitwarden.json                   # passwords and passkeys from a JSON export
cat export.csv | unbrowse-node vault import -               # or from stdin
unbrowse-node session import github.com                     # cookies: your browser's session for one host
unbrowse-node session import github.com --from cookies.txt  # cookies: from a file you exported
unbrowse-node session list                                  # the sessions the node holds, by host and cookie count
unbrowse-node session forget github.com                     # drop a host's session
unbrowse-node passkey import bitwarden.json                 # passkeys alone (unless passkeys are off)
```

- **Passwords.** A CSV from Chrome, Edge, Brave, Firefox, Safari, Apple Passwords, 1Password, Bitwarden, LastPass,
  Dashlane, Proton Pass, KeePassXC and the like: the columns are found by what their names say, and a TOTP column
  comes along as the login's one-time code key. A JSON export from Bitwarden (unencrypted) or in the FIDO Credential
  Exchange Format reads too. A login the vault already has keeps the vault's password. A login saved in an Android
  app (`android://…@<package>`, `androidapp://<package>`) comes in under the website that claims the app: the node
  reads the app's Play Store listing for the sites it links to, and takes the one whose Digital Asset Links file
  (`/.well-known/assetlinks.json`) names the app, and its signing certificate where the export kept it, as sharing its
  logins (`get_login_creds`). Only those public pages are fetched, with no login in the request. An app no site claims
  that way, or that two sites claim, is left out and counted. Where a password goes: sealed under the root key
  (XChaCha20-Poly1305, bound to its login), in `~/.unbrowse/vault.sealed.keychain.json` when the root key is in the
  system's keystore and in `~/.unbrowse/vault.sealed.json` when it is in a file (a Linux machine with no desktop
  session, or a dev build). The keystore holds only the root key, read once a run, so the vault unlocks once and no
  call asks again (`vault.unlock-once`); a headless node imports and signs in too. On a Mac over SSH the login Keychain is locked: `security unlock-keychain` first.
- **Cookies.** One host at a time, on your word. Without `--from`, the node reads the browser chosen in Settings: it
  copies that browser's cookie store into a throwaway profile, opens it headless and asks it for its cookies, so the
  browser decrypts them and the node never reads the store itself. With `--from`, it reads a file: a cookie
  extension's JSON export, a Netscape `cookies.txt`, a Playwright or Puppeteer storage state, or a bare `Cookie:`
  header. Either way only the cookies a browser would send to that host are kept (its own and its parent domain's);
  another site's in the same store or file are dropped before anything is written. They become the host's session for
  calls (`~/.unbrowse/jars/<host>.json`) and go into the node's browser profile for the host
  (`~/.unbrowse/profiles/<host>`, and any profile it keeps for another host on the same site), so the first call and
  the first browsed page are both signed in. A session cookie is kept in the profile for 30 days, since the node's
  browser closes between uses. Name the host the site's pages are on (`www.` included, if the site uses it). A
  browser that locks its cookies to itself (Chrome's app-bound encryption on Windows) can't be read in place: export
  its cookies to a file and use `--from`.
- **Passkeys.** Only where a passkey can leave its authenticator. Bitwarden's unencrypted JSON export, a FIDO
  Credential Exchange (CXF) file and KeePassXC's `.passkey` export carry the passkey's private key, and the node
  imports those: sealed in the vault like one you enrolled (`manual` in `passkey list`), used the same way, its counter
carried on. Not while passkeys are off, and never for a site you said `passkey never` to. The browser's
  authenticator signs with ECDSA P-256, which is what these managers make; a key on another curve is counted and left
  out. iCloud Keychain (Apple Passwords), Google Password Manager, Windows Hello and security keys never let a passkey
  out to a file: Apple and Google hand them only to another credential manager app on the same device (the Credential
  Exchange Protocol), which the node isn't. For those sites, enrol a new passkey for the node (`passkey enrol`, below).
  A passkey imported from a manager still works in that manager: the site sees one credential used from two places.

Nothing is imported from another node or a cloud vault: logins, sessions and passkeys are this node's alone and never
cross the peer network. The recovery phrase brings derived passwords back on a new machine (they are made from the
root key); stored passwords, sessions and passkeys move as exports, by the owner.

## The agent API

On 127.0.0.1 only, each request with the agent's token from its setup: `POST /v1/do`, `POST /v1/browse`,
`GET /v1/routes`, `POST /v1/routes/{id}/call`, `GET /v1/logins`, `GET /v1/whoami`, `POST /v1/report`, and the same
seven as MCP tools at `POST /mcp`. Each is one entry in `PRIMITIVES` (`app/src/api.rs`), from which `agent-api.json` is
written; the window uses `/owner/*` with the owner's token. What each does, and every owner command: [CLI.md](../docs/CLI.md#5-the-agent-api-and-mcp-tools).
Clients: [`unbrowse-sdk`](../unbrowse-sdk). Agent instructions: [`skills/unbrowse`](../skills/unbrowse/SKILL.md).

## The owner's hands on a page

A site's browser runs with no window. When a page needs the owner (a sign-in the vault has no login for, a two-step
code, a check that wants a person), the window's **Browser** screen shows it as a live picture (Chrome's screencast,
a few frames a second, `app/src/hands.rs`). A click on the picture is a click at the same point on the page, and keys
go to the page: text, Enter, Tab, Backspace, the arrows, and Command-V to paste. The owner can open it whenever they
like; an agent can ask for it with `unbrowse_browse ["ask_owner", "<what it needs>"]`, which brings the window
forward and waits (5 minutes, `--timeout` up to 30) until the owner presses **Done, give it back** or **Can't do it**.
The reply says `owner: done | declined | no_answer`, and the page's address.

Before a page comes to the owner, an agent that can see the page meets a check itself: `unbrowse_challenge` shows the
page as a picture (a path the node writes, at CSS-pixel size) with its text and `asks` — whether it still asks for a
person — and takes one step the agent names: `click`, `drag`, `type`, `press`, `wait` or `done`. Every reply is the page
again, so the agent's own model reads what its step did, and `asks` is the page's own answer, never a claim. What a
picture cannot settle — a password, a one-time code — is the owner's, below.

- Only the owner's window drives the page: the commands are `/owner/hands*`, behind the owner's token. An agent can
  only ask.
- The owner's first click or key takes the page: agents' commands on that site wait until it's given back.
- What the owner types into a password or one-time-code field (or a frame from another site that the page can't
  see into) leaves the walk record before the form can send it, and anything the browser returns to an agent says
  `[typed by the owner]` instead. No agent script runs on that page while it may hold it. Nothing typed is logged.
- The learner's flow ends where the owner took the page and again where they gave it back, so a sign-in done by hand
  never becomes a route. After **Done**, the window offers to keep the login in the vault (the Vault's own form), so
  later sign-ins use its `vault:` reference.
- The cookies the sign-in earned stay in the site's profile: the agent's next step, and its next `unbrowse_do`, are
  signed in.

## What never leaves the node

- **Passwords and one-time codes.** Agents name a login as `vault:<site>:<account>` and its two-step code as
  `vault:code:<site>:<account>`; the node types the password or makes the code itself, only into a field whose page
  and frame are on that login's site. Walk records and routes keep the reference. A stored password is sealed
  under the root key (`vault.sealed.keychain.json`, or `vault.sealed.json` on a node whose root key is in a file). See
  [`SECURITY.md`](../SECURITY.md#how-the-node-keeps-secrets).
- **Cards.** Agents fill a card's fields as `vault:card:<label>:<field>`; the node types them itself, into a page
  that came over https and a field whose frame is on that page's site. Every checkout page asks the owner first, in the window,
  showing the card and the site it goes to; one approval covers that card's fields on that page, in the asking
  session's tab. From the moment the owner is asked until they say the checkout is finished or
  dismissed (`unbrowse-node checkout done|dismiss`), agents can't act on that site or any host the checkout names.
  Every route call that pays with a card asks again. The owner adds a card with
  `unbrowse-node vault card add <label>` (from stdin). `cards.json` holds labels and last four digits only.
- **Passkeys.** A website passkey's credential (its id, user handle, private key and counter) is sealed in
  `passkeys.json`; the list shows the site, the account, a short name and how it was enrolled only. It goes only to the browser's
  authenticator, never to an agent, a log, the network or a peer.
- **Sessions.** The window and agents see how many cookies a site holds, never their values.
- **Keys.** Everything that touches key material is in `crates/core`; the window gets public values only.
- **The owner's yes.** The recovery phrase, a vault password, a key backup, replacing the key, raising an agent's cap
  and linking a wallet the sign-in page answered with each wait on the owner: a dialog the node opens itself, or, on a
  node with no screen, the owner passphrase typed on a terminal:

  ```sh
  unbrowse-node passphrase            # once: set it (10+ characters), typed twice on this terminal
  unbrowse-node confirm               # when the node waits: shows each question, takes the passphrase or Enter to refuse
  ```

  See [`SECURITY.md`](../SECURITY.md#the-owners-yes).

## Website passkeys (on by default)

A headless browser has no authenticator, so "verify it's you: use your passkey" stops an agent until a person acts.
The node keeps a site's passkey in its vault and answers that prompt itself (`app/src/passkey.rs`). This is on unless
the owner turns it off, and the node says so the first time it starts.

**The risk.** Any site the node signs in to may get a passkey registered on the owner's account, with no step from
the owner. Whoever controls the node can then sign in as the owner there: the owner, anyone with the machine, and
every agent with a key, because agents drive the node's browser and the node answers the passkey prompt for them
with no prompt to the owner. The passkey is the second factor, so it stands in for the password and the second step
together. A Google (Gmail) account is the highest-value target: it resets most other accounts' passwords. Run the
node only on a machine the owner controls, and say `passkey never` to any site an agent shouldn't hold for good.

**Opting out.** `unbrowse-node passkey off` (or `UNBROWSE_PASSKEYS=0`, which wins over the setting) stops all
enrolment and sign-in; kept passkeys stay sealed until removed. `unbrowse-node passkey never <site>` does the same for
one site and its subdomains (Settings `passkeys_never`), and takes the authenticator off its pages at once; `passkey
allow <site>` undoes it. Neither deletes what a site already registered: see *Deleting one* below.

**What it does.**

- *Enrol after the owner signs in (automatic).* When the **owner** signs in on a page they took over (`ask_owner`,
  gave back done), the node attaches a virtual authenticator to the site's pages in its own browser for ten minutes.
  A passkey the site offers to make in that time, from its "add a passkey?" prompt after sign-in or made on its own,
  is made on that authenticator and kept, marked `auto`, with one activity line ("Enrolled a passkey the site offered
  after signing in", the site and when). The node
  never goes into a site's settings to make one; a site that doesn't offer one gets none. One sign-in keeps one
  passkey. **A vault login an agent fills arms nothing** (`passkey::SignIn::Agent`): a passkey signs in as the owner
  with no password and no second factor, so one an agent could make would be a credential stronger than the agent's
  own key, and every key on the node as strong as the weakest of them. An agent can click a site's "add a passkey"
  button, but with nothing armed the credential is refused; the owner enrols one with `passkey enrol <site>`.
- *Enrol by hand (once per site, by the owner).* While the node's browser is signed in to the site, `passkey enrol <site>`
  attaches a virtual authenticator to the site's pages (Chrome's WebAuthn domain over DevTools: CTAP2, internal
  transport, resident keys, user verification) and waits. The site's own "add a passkey" flow, done by the owner or
  driven by an agent, makes the credential on it, and the node keeps it. A credential a site makes when no enrolment
  is waiting is refused, removed from the page and logged: the site may list it, so delete it there.
- *Use.* Whenever an agent browses a site the vault holds a passkey for, the node attaches the authenticator with the
  passkey loaded, so `navigator.credentials.get` completes with no one there. Chrome checks the passkey's site
  against the page before it signs. The new signature counter goes back into the vault, and every sign-in is a line in
  the activity log ("Signed in with a stored passkey", the site and when, nothing more).
- *Import.* A passkey a password manager exported (Bitwarden JSON, CXF, KeePassXC `.passkey`) goes in with
  `passkey import <file>` or `vault import <file>`, and is used the same way as an enrolled one. Platform passkeys
  (iCloud Keychain, Google Password Manager, Windows Hello, security keys) can't be exported: enrol one instead. See
  [Imports](#imports-from-the-window-or-a-shell).
- *Storage.* `~/.unbrowse/passkeys.json` lists each passkey by site, account and a short name (from its credential
  id's hash). The credential is sealed with XChaCha20-Poly1305 under a key derived from the root key in the Keychain
  (`crates/core/src/sealed.rs`), bound to its entry. Nothing in it is announced, served or synced: it is this node's
  alone, like its logins.

**Commands.** Enrolling and using need the node running; the rest (importing too) reads and writes the vault.

```bash
unbrowse-node passkey off                                  # or UNBROWSE_PASSKEYS=0; `passkey on` (=1) turns it back on
unbrowse-node passkey never google.com                     # never on this site; `passkey allow google.com` undoes it
unbrowse-node passkey enrol google.com [--wait 600]        # the node's browser for the site, signed in
unbrowse-node passkey list                                 # id, site, account, auto|manual, last used: never the credential
unbrowse-node passkey import bitwarden.json                # a password manager's export of passkeys
unbrowse-node passkey remove <id>                          # then delete it on the site's account page too
unbrowse-node passkey enrol google.com --cdp http://127.0.0.1:9333   # a browser the node doesn't run
unbrowse-node passkey use google.com --cdp http://127.0.0.1:9333     # load it there, while that browser runs
```

The window's commands are `POST /owner/passkeys`, `passkey_enrol` `{site, cdp?, minutes?}`, `passkey_use`
`{site, cdp}`, `passkey_never` `{site, never?}` and `passkey_remove` `{id}`. Agents get no passkey command: they only browse, and the node signs in.

**Deleting one.** `unbrowse-node passkey remove <id>` deletes it from the node. The site still lists it and accepts it
from anyone holding a copy, so delete it on the site's account page too (security, passkeys; on Google,
`https://myaccount.google.com/signinoptions/passkeys`). `passkey list` names the site and account of each.

**Enrolling Google, once, by hand** (if Google didn't offer one after the node signed in).

1. `unbrowse-node passkey on`, if it was turned off.
2. Sign in to Google in the node's browser: have the agent open `https://myaccount.google.com` with
   `unbrowse_browse`, and finish any check in the node's window.
3. `unbrowse-node passkey enrol google.com --wait 600`.
4. In that browser open `https://myaccount.google.com/signinoptions/passkeys`, choose **Create a passkey**, then
   **Continue** (Google may ask for the password first). The command prints `enrolled passkey <id> on google.com for
   <you>@gmail.com`.
5. On the same Google page, rename the new passkey "Unbrowse node", so you can find it to delete it later.

From then on, when Google asks the node's browser to verify it's you, the node answers. To undo it:
`unbrowse-node passkey remove <id>`, and delete "Unbrowse node" on Google's passkeys page.

**Limits.** The node attaches the authenticator around each browse command, so a page that asks for the passkey on
the very first load of a browser that just started may need its "Try again". The learner's own walks don't get
passkeys; browsing does. `--cdp` takes a browser on this machine only (the credential crosses DevTools in the clear), and
anything else driving that browser over DevTools can sign in with the loaded passkey too: treat it as holding it.

## Payments, sharing and the peer network

The node runs Anvil in `~/.unbrowse/devnet` and deploys the contracts there itself, or runs on a live Arc network whose
contracts its network file names (`app/networks/<name>.json`). It pays another contributor's fee for a route by itself,
once, when it fetches the body, up to the owner's per-fetch maximum (`max_fetch_usdc`, 0.05 USDC). Its own routes are
free to its own agents, listed or not: no voucher, no line, nothing against a key's cap. A route made from another
contributor's body only ever goes over HTTPS to public internet addresses ([SHARING.md](../docs/SHARING.md)). Until its
owner signs in it is local: it joins nothing and lists nothing. From sign-in on it lists the routes its agents keep using
(`app/src/autolist.rs`), and finds other nodes' routes through a Kademlia table keyed by site (`crates/net`,
`app/src/peers.rs`). Every write and every fee the node pays itself, in USDC on Arc: there is no sponsor (spec §76). A
node that only earns needs a few cents once, for its identity.

```bash
unbrowse-node wallet                     # the node's address, the linked owner wallet, the network and its gas
unbrowse-node wallet address --copy      # the address alone, and on the clipboard
unbrowse-node sign-in                    # sign in to the network (Privy on the site, or --wallet <address>)
unbrowse-node share                      # what the node lists by itself, and why each route waits
unbrowse-node network [on|off|light|full]
```

The detail: [MONEY.md](../docs/MONEY.md) (every cost, the split, decimals), [ONBOARDING.md](../docs/ONBOARDING.md) (the
sign-in and paying its own way), [SHARING.md](../docs/SHARING.md) (what is shared and how) and [NETWORK.md](../docs/NETWORK.md) (the
peer network). The contracts are [`unbrowse-settlement`](../unbrowse-settlement).

## Usage telemetry

On by default in a release build, off in a dev build (`UNBROWSE_TELEMETRY=1` turns it on there). At each start the
node says on stderr whether it is on and how to turn it off. `unbrowse-node telemetry [on | off]` shows or sets the
choice, kept in `~/.unbrowse/telemetry.json` with the random install id; `UNBROWSE_TELEMETRY=0` overrides the file;
`UNBROWSE_TELEMETRY_URL` sends elsewhere. An event is which tool ran, how it ended, how long it took, the version, the
OS and the install id: the full list, and what is never sent, is in the [README](../README.md#usage-telemetry). The
code is `app/src/telemetry.rs`; the worker that takes the events is [`unbrowse-telemetry`](../unbrowse-telemetry).

A failed call is never reported on the chain. A route call or paid fetch that ran and failed is counted here instead
(`route_failed`, or `fetch_failed` for a paid fetch of another identity's entry), by its kind of failure alone. With
bug reports on (`unbrowse-node reports on`), a failed call of a route made from another contributor's body is also
filed by the node as an issue on unbrowse-ai/unbrowse: its kind of failure, step and status and the route's shape,
never what the site said, at most once a day for one problem.

A node whose owner has linked their wallet (signed in with Privy) also tells the site three events while telemetry is
on: `node_started`, `owner_linked` and `owner_unlinked`. Each is signed by the node's key and carries the owner's link,
so the site counts only events a node really sent, under the wallet that owns it (`link::tell`). These name the node's
address and the owner's wallet, which the owner gave the site by signing in. They never name a site, route or input.
A node with no linked owner sends none.

## Tests

```bash
cargo test --workspace
cargo test -p unbrowse-node-app peers -- --ignored   # on Anvil: two nodes find each other's routes by site
```

Tests run their own chain (`UNBROWSE_DEVNET_PORT`) and their own home (`UNBROWSE_HOME`), so they never touch the
owner's data. Every suite, and how to run the Anvil tests one per process: [TESTING.md](../docs/TESTING.md).

## Licence

[Apache-2.0](../LICENSE).
