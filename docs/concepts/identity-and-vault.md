# Identity and the vault

## Identity

In the design a participant is a **wallet**, not a machine. One wallet owns a person's nodes, agent keys, route coins
and earnings, and registers exactly one **ERC-8004** identity on Arc. The identity's on-chain metadata names its nodes'
peer IDs and addresses, so other nodes can find them and check who they are. There are no accounts, passwords or user
database; any wallet will do (spec §1.2, R1.12 to R1.15). The node joins on its own wallet, with no sign-in, and
needs a few cents of USDC on Arc once, to register. Each passed fetch then buys and stakes the route's coin for that
wallet; beyond that, the node buys, stakes or sells a coin only when its owner asks ([Payments and UNB](payments-and-unb.md#route-coins)).
Rule names are those of the current spec, `protocol/spec/` in unbrowse-papers.

The node's **root key** is the seed of everything else secret: agent keys, the vault key and derived passwords are all
computed from it, so nothing per agent or per site has to be stored or backed up. It lives in the system's keystore
(the Keychain on macOS, the Credential Manager on Windows, the Secret Service on Linux) or, on a Linux machine with no
keystore, in a file only its user can read.

### Agent keys

An agent never holds the root key. The owner authorises an **agent key** with a spending **cap** per epoch and an
**expiry**, on chain, and can **revoke** it (R1.20). The agent spends within that cap; the contract pays no line signed
by a key past its cap, after its expiry or after its revocation (R1.22).

## The vault

Many routes need the node to be **signed in** to a site. The vault holds what that takes, so an agent gets a
*reference* to a login, never its value. Cookies, tokens and passwords never leave the owner's nodes (R1.24, R2.2).

- **Sessions**: a site's cookies, kept per host. The first call to a site walks it once and keeps the session; after
  that, calls run signed in.
- **Logins**: a site's username and password. A **derived** password is made from the vault key, the site and a
  counter, and is never stored; a **stored** password lives in the keystore. A login can keep a site's **two-step code
  key**, so an agent fills the one-time code by reference too.
- **Passkeys**: when the node signs in with a vault login and the site offers a passkey, the node keeps it, sealed under
  the root key, and answers the prompt itself.

### Getting a session in

Both ways are the owner's choice and scoped to one site:

- **Walk once**: the node opens the site in its browser, you sign in, and the session is kept.
- **Import a site's session**: the node asks *your own browser* for that one site's cookies (the browser decrypts them;
  the node never reads the cookie store itself) and keeps them as the session.

Neither is a sweep: the node reads one site's cookies, on your word, never every cookie from every browser. A node that
also serves other nodes and joins a peer network should not hold every account you are signed in to.

## In the code today

**Built.**

- **Route coins are built.** The contracts are in [`unbrowse-settlement/src/coins/`](../../unbrowse-settlement/src/coins/README.md) (the coin, its curve, staking, the fetch path and bounties), Settlement pays the 65 / 30 / 5 split and calls them on every claimed line, and the node trades, stakes, claims and ranks through them (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`). The earlier economy (entry bond, route pool, fraud court, HTTP domain witnesses) is removed. Nothing is deployed yet: Arc mainnet has no deployment, and the earlier Arc testnet contracts are no longer supported.
- The root key and everything derived from it: `unbrowse-node/crates/core/src/derive.rs` (`RootKey::agent`,
  `vault_key`, `password`), the keystore and the file fallback in `keystore.rs`, a new node's 12 seed words in
  `seed.rs`, and the recovery phrase in `recovery.rs`: 12 seed words, which open the node's wallet in any wallet app,
  or an older node's 24 words, which bring back that node only.
  [ARCHITECTURE.md §6](../ARCHITECTURE.md#6-keys-and-the-vault).
- The ERC-8004 identity: the node registers one for its key and publishes its peer ID, addresses and version
  (`app/src/erc8004.rs` `ensure`, `publish`); peers are admitted against it
  ([NETWORK.md §2](../NETWORK.md#2-who-counts-admission)).
- Agent keys: `app/src/agents.rs`, `authorizeAgent` / `revokeAgent` on Settlement, each with a token derived from its
  key. The contract keeps a key's expiry as a block number (`AgentKey.expiry` in `LeanSettlement.sol`), as R1.20 has
  it; the node keeps it as a date (`Agent::expires`). The key the node makes for itself is capped at 5 USDC an epoch (`agent.key_cap`, spec §76.1 item 2: 100 fetches
  at the 0.05 maximum, so a stolen node spends at most that) for 30 days, and renewed before it runs out. The owner
  raises it under Advanced (`unbrowse-node agent cap <index> <usdc>`, the SDK's `setAgentCap` / `agent_set_cap`), and
  the node keeps the owner's cap at every renewal. A node made when the default was 100 keeps working at 100 until its
  key's next renewal, which takes 5 unless the owner set a cap. The window's New agent key and
  `unbrowse-node agent new <name> [cap] [days]` start at 5 and 30 ([CLI.md](../CLI.md#agent),
  [MONEY.md §3](../MONEY.md#3-where-money-flows)).
- An encrypted backup of the node's key (spec §76.1 item 1.4): `unbrowse-node wallet export <file>` and
  `wallet import <file>` (passphrase on stdin), and `wallet_export` / `wallet_import` in the SDK. The file is an
  Ethereum keystore (Web3 Secret Storage v3: scrypt 2^18, AES-128-CTR) under a passphrase of 10 characters or more, so
  it also opens in any wallet that imports a keystore file, and restores the node on a new machine; the key it
  replaces is kept beside the root key (`crates/core/src/backup.rs`).
- One wallet, several nodes (spec §76.1 item 1.7): each node linked to the same wallet asks it to grant its agent
  keys against the wallet's own deposit (`unbrowse-node nodes grant`, `wallet_grant`: one `authorizeAgent` call each,
  which the wallet sends, since a grant is the payer's own). Once the chain has a grant, that key's vouchers name the
  wallet as payer from the next voucher epoch it hasn't begun, so the nodes share one deposit, each key with its own
  cap. `unbrowse-node nodes` (`owner_nodes`) lists the wallet's deposit and every key it granted, this node's marked
  (`app/src/owner_nodes.rs`).
- The sign-in page sends those grants in the same flow as the sign-in signature (spec §76.2 item 4): the node names its
  live keys in the page's fragment (`link::page_with`, `grants=`), and the page (`unbrowse-landing` `src/link/grants.ts`)
  sends `authorizeAgent` for each from the owner's wallet, as one batch where the wallet takes one. A week before a
  wallet's grant runs out, the node asks once in the activity log and the window shows Renew, which opens the page in
  its renewal mode (`wallet_renew`, `nodes renew`): one step for all of them (§76.2 item 3). Grants keep their 30-day
  expiry, and the node never asks for one without an expiry (`chain::authorize_call`).
- The vault, sessions and session import: `app/src/vault.rs`, `jars/<host>.json`, `app/src/import.rs` (`session`,
  `session_from`), passkeys in `app/src/passkey.rs`. The root [README](../../README.md#website-passkeys-on-by-default)
  states the passkey risk and how to turn it off.
- Linking a wallet of the owner's to the node, which is optional (the node joins on its own wallet, spec §86): with
  Privy on Unbrowse's site, or the owner's own wallet, `app/src/link.rs`
  ([ONBOARDING.md §2](../ONBOARDING.md#2-linking-a-wallet-optional)).

**Differs from the design.**

- **The node's key is the wallet.** The spec has the person's wallet own the identity and certify each node's peer key
  (R1.12, R1.18). In the code the node's root key is the wallet: it registers the ERC-8004 identity, holds the deposit,
  coins and earnings, and signs every write. The owner's Privy wallet only signs a link to the node, kept off chain in
  `~/.unbrowse/owner.json`; it holds nothing and pays for nothing ([MONEY.md §1](../MONEY.md#1-three-balances)).
- **One identity per node.** A second node of the same owner registers its own identity; each runs as index 0
  (`peers::INDEX`). The spec allows 16 nodes under one identity (R7.22). Several nodes of one wallet now share its
  deposit and keep their own keys and caps (above), but not its identity: a listing is signed by the wallet that holds
  the identity (`Listings`), and the node doesn't hold the owner's key. A key the wallet granted signs no listing and is
  no fraud evidence, so a stolen node key costs at most its cap: the owner decided this on issue #184, reversing spec
  §76.2 item 1. Lines the wallet pays don't count as checks of the node's own stake either, because the
  court takes a check only from the line's payer.
- **The wallet sends its own grants.** R1.20 has the app grant the key automatically. Settlement takes `authorizeAgent`
  only from the payer, so a node paying from the owner's wallet needs the wallet to send that call: from the CLI's
  `cast send` lines, or, once the website does it, from the sign-in page. A key the wallet hasn't granted pays from the
  node's own deposit, as before.
- **The keystore, not a passkey, unlocks the root.** The spec derives agent keys from a root the user's passkey unlocks
  (R1.23).
- **The website signs in with Privy**, or the owner signs the same plain message with a wallet of their own
  (`link_wallet`), not with Sign-In with Ethereum (R1.19).

**Not built yet.**

- Proof of personhood (R1.33, R1.34).
- A per-site authorisation for signed-in calls that names the agent, the site, what it may do, a cap and an expiry
  (R1.24): an agent key reaches every site the vault holds.
- A moved identity counting as having left (R6.21).

Related: [Decentralised from launch](decentralised.md) · [SECURITY.md](../../SECURITY.md).
